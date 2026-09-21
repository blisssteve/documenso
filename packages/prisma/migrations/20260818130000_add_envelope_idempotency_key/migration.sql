-- AlterTable
ALTER TABLE "Envelope" ADD COLUMN     "idempotencyKey" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX "Envelope_teamId_idempotencyKey_key" ON "Envelope"("teamId", "idempotencyKey");
