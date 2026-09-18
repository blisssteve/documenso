import { BackgroundJobStatus, WebhookTriggerEvents } from '@prisma/client';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sign } from '../../server-only/crypto/sign';
import { EXECUTE_WEBHOOK_JOB_DEFINITION } from '../definitions/internal/execute-webhook';
import '../definitions/internal/execute-webhook.handler';
import { LocalJobProvider } from './local';

const db = vi.hoisted(() => ({
  backgroundJob: { update: vi.fn() },
  webhook: { findUniqueOrThrow: vi.fn() },
  webhookCall: { create: vi.fn() },
}));

vi.mock('@documenso/prisma', () => ({ prisma: db }));
vi.mock('../../constants/app', () => ({ NEXT_PRIVATE_INTERNAL_WEBAPP_URL: () => 'http://jobs.test' }));
vi.mock('../../constants/crypto', () => ({ DOCUMENSO_ENCRYPTION_SECONDARY_KEY: 'a'.repeat(64) }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
}));

const webhookName = 'internal.execute-webhook';
const webhookUrl = 'https://receiver.test/webhook';
const payload = { event: WebhookTriggerEvents.DOCUMENT_COMPLETED, webhookId: 'webhook-test', data: {} };

const provider = LocalJobProvider.getInstance();
const app = new Hono();
app.use('/api/jobs/*', provider.getApiHandler());

let row: { id: string; jobId: string; status: BackgroundJobStatus; retried: number; maxRetries: number };
let dispatched: Request[];
let dispatchTimes: number[];
let outbound: ReturnType<typeof vi.fn<typeof fetch>>;

const request = (name = webhookName, retry = false) => {
  const body = { name, payload };
  return new Request(`http://jobs.test/api/jobs/${name}/job-test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Job-Id': row.id,
      'X-Job-Signature': sign(body),
      ...(retry ? { 'X-Job-Retry': '1' } : {}),
    },
    body: JSON.stringify(body),
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS', '');
  vi.clearAllMocks();
  provider.defineJob(EXECUTE_WEBHOOK_JOB_DEFINITION);
  row = { id: 'job-test', jobId: webhookName, status: BackgroundJobStatus.PENDING, retried: 0, maxRetries: 3 };
  dispatched = [];
  dispatchTimes = [];
  outbound = vi.fn<typeof fetch>();
  db.backgroundJob.update.mockImplementation(({ where, data }) => {
    if (where.id !== row.id || where.status !== row.status) {
      return Promise.reject(new Error('Atomic claim lost'));
    }
    row = { ...row, status: data.status, retried: row.retried + (data.retried?.increment ?? 0) };
    return Promise.resolve({ ...row });
  });
  db.webhook.findUniqueOrThrow.mockResolvedValue({ id: payload.webhookId, webhookUrl, secret: 'fixture-secret' });
  db.webhookCall.create.mockResolvedValue({});
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input, init) => {
      if (String(input).startsWith('http://jobs.test/api/jobs/')) {
        dispatched.push(new Request(input, init));
        dispatchTimes.push(Date.now());
        return Promise.resolve(new Response('accepted', { status: 202 }));
      }
      expect(String(input)).toBe(webhookUrl);
      expect(init?.redirect).toBe('manual');
      return outbound(input, init);
    }),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('local webhook retries through the jobs API', () => {
  it('exhausts three paced retries and returns FAILED/500 without another dispatch', async () => {
    // Each fetch gets its own body, just like a real HTTP response.
    outbound.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    let attempt = Promise.resolve(app.request(request()));
    for (const [index, delay] of [5_000, 10_000, 20_000].entries()) {
      let responded = false;
      void attempt.then(() => {
        responded = true;
      });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(row).toMatchObject({ status: 'PROCESSING', retried: index, maxRetries: 3 });
      expect(dispatched).toHaveLength(index);
      expect(responded).toBe(false);
      expect((await app.request(request(webhookName, true))).status).toBe(404);
      expect(row.retried).toBe(index);
      await vi.advanceTimersByTimeAsync(1);
      expect((await attempt).status).toBe(200);
      expect(row.status).toBe('PENDING');
      attempt = Promise.resolve(app.request(dispatched[index]));
    }
    const final = await attempt;
    expect(final.status).toBe(500);
    expect(await final.text()).toBe('Task exceeded retries');
    expect(row).toMatchObject({ status: 'FAILED', retried: 3, maxRetries: 3 });
    expect(outbound).toHaveBeenCalledTimes(4);
    expect(db.webhookCall.create.mock.calls.map(([call]) => call.data.responseCode)).toEqual([503, 503, 503, 503]);
    expect(dispatchTimes).toEqual([5_000, 15_000, 35_000]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatched).toHaveLength(3);
  });

  it('does not delay a non-webhook retry', async () => {
    const name = 'internal.other-job';
    const handler = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
    provider.defineJob({ id: name, name, version: '1', trigger: { name }, handler });
    row.jobId = name;
    expect((await app.request(request(name))).status).toBe(200);
    expect(dispatchTimes).toEqual([0]);
    expect(row).toMatchObject({ status: 'PENDING', retried: 0 });
    expect((await app.request(dispatched[0])).status).toBe(200);
    expect(row).toMatchObject({ status: 'COMPLETED', retried: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(outbound).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature before claiming or executing', async () => {
    const invalid = request();
    invalid.headers.set('X-Job-Signature', 'invalid');
    expect((await app.request(invalid)).status).toBe(401);
    expect(db.backgroundJob.update).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it('keeps the request and claim active after timeout and 409 until the receiver finishes', async () => {
    let remoteCompleted = false;
    outbound.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          // The receiver keeps its reservation/work after the HTTP client aborts.
          setTimeout(() => {
            remoteCompleted = true;
          }, 20_000);
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    outbound.mockImplementation(
      async () =>
        new Response(remoteCompleted ? 'done' : 'completion already in progress', {
          status: remoteCompleted ? 200 : 409,
        }),
    );

    let responded = false;
    const first = Promise.resolve(app.request(request())).then((response) => {
      responded = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.webhookCall.create.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', responseCode: 0 });
    expect(remoteCompleted).toBe(false);
    expect(row.status).toBe('PROCESSING');
    expect(dispatched).toHaveLength(0);
    expect(responded).toBe(false);
    expect((await app.request(request(webhookName, true))).status).toBe(404);
    expect(row.retried).toBe(0);
    expect(outbound).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(dispatched).toHaveLength(0);
    expect(responded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await first).status).toBe(200);
    expect(row.status).toBe('PENDING');
    expect(dispatchTimes).toEqual([15_000]);

    const second = app.request(dispatched[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(db.webhookCall.create.mock.calls[1][0].data).toMatchObject({ status: 'FAILED', responseCode: 409 });
    expect(remoteCompleted).toBe(false);
    expect(row).toMatchObject({ status: 'PROCESSING', retried: 1 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(remoteCompleted).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect((await app.request(request(webhookName, true))).status).toBe(404);
    expect(row.retried).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).status).toBe(200);
    expect(dispatchTimes).toEqual([15_000, 25_000]);

    expect((await app.request(dispatched[1])).status).toBe(200);
    expect(row).toMatchObject({ status: 'COMPLETED', retried: 2, maxRetries: 3 });
    expect(db.webhookCall.create.mock.calls.map(([call]) => call.data.responseCode)).toEqual([0, 409, 200]);
    expect(dispatched).toHaveLength(2);
  });
});
