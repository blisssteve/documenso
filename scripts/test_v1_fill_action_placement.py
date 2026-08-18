from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
EMBED_PAGE = REPO_ROOT / "apps/remix/app/components/embed/embed-document-signing-page-v1.tsx"
STANDARD_PAGE = REPO_ROOT / "apps/remix/app/components/general/document-signing/document-signing-page-view-v1.tsx"


class V1FillActionPlacementTest(unittest.TestCase):
    def test_embed_fill_action_is_inside_widget_form(self) -> None:
        source = EMBED_PAGE.read_text()
        widget_form = source.index('className="embed--DocumentWidgetForm')
        fill_action = source.index("<DocumentSigningAutoSign", widget_form)
        widget_form_end = source.index('className="hidden flex-1 group-data-[expanded]/document-widget:block md:block"')

        self.assertLess(fill_action, widget_form_end)

    def test_standard_route_fill_action_is_inside_widget_form(self) -> None:
        source = STANDARD_PAGE.read_text()
        widget_form = source.index("<DocumentSigningForm")
        fill_action = source.index("<DocumentSigningAutoSign", widget_form)
        widget_form_end = source.index("</div>", fill_action)
        readonly_fields = source.index("<DocumentReadOnlyFields", widget_form)

        self.assertLess(fill_action, widget_form_end)
        self.assertLess(widget_form_end, readonly_fields)


if __name__ == "__main__":
    unittest.main()
