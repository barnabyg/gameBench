import type { Page } from "playwright";
import { z } from "zod";

export const layoutSchema = z.object({
  event: z.literal("promotion-layout"),
  resolution: z.object({
    width: z.int().positive(),
    height: z.int().positive(),
  }),
  issues: z.array(
    z.object({
      type: z.enum(["clipping", "overlap"]),
      target: z.string(),
      other: z.string().optional(),
    }),
  ),
});
type Issue = z.infer<typeof layoutSchema>["issues"][number];

export async function inspectPromotion(page: Page): Promise<Issue[]> {
  return page.getByTestId("panel-notice").evaluate((panel) => {
    const tolerance = 2;
    const issues: Issue[] = [];
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "h2, p, button[data-testid=continue]",
      ),
    ).flatMap((element, index) => {
      if (
        !element.getClientRects().length ||
        getComputedStyle(element).visibility !== "visible"
      )
        return [];
      const target =
        element.dataset.testid ?? `${element.localName}-${index + 1}`;
      const textRects: DOMRect[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        textRects.push(
          ...Array.from(range.getClientRects()).filter(
            (rect) => rect.width && rect.height,
          ),
        );
      }
      if (
        textRects.some((rect) => {
          let inVerticalScroller = false;
          for (
            let ancestor: HTMLElement | null = element;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            const style = getComputedStyle(ancestor);
            const bounds = ancestor.getBoundingClientRect();
            const left = bounds.left + ancestor.clientLeft;
            const top = bounds.top + ancestor.clientTop;
            if (
              ["hidden", "clip"].includes(style.overflowX) &&
              (rect.left < left - tolerance ||
                rect.right > left + ancestor.clientWidth + tolerance)
            )
              return true;
            if (
              ["hidden", "clip"].includes(style.overflowY) &&
              (rect.top < top - tolerance ||
                rect.bottom > top + ancestor.clientHeight + tolerance)
            )
              return true;
            if (
              ["auto", "scroll"].includes(style.overflowY) &&
              ancestor.scrollHeight > ancestor.clientHeight + tolerance &&
              top < window.innerHeight &&
              top + ancestor.clientHeight > 0 &&
              rect.top + ancestor.scrollTop >= top - tolerance &&
              rect.bottom + ancestor.scrollTop <=
                top + ancestor.scrollHeight + tolerance
            )
              inVerticalScroller = true;
          }
          return (
            rect.left < -tolerance ||
            rect.right > window.innerWidth + tolerance ||
            (!inVerticalScroller &&
              (rect.top < -tolerance ||
                rect.bottom > window.innerHeight + tolerance))
          );
        })
      )
        issues.push({ type: "clipping", target });
      return [
        {
          target,
          rects:
            element.localName === "button"
              ? [element.getBoundingClientRect()]
              : textRects,
        },
      ];
    });
    for (const [index, first] of items.entries()) {
      for (const second of items.slice(index + 1)) {
        if (
          first.rects.some((a) =>
            second.rects.some(
              (b) =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) >
                  tolerance &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >
                  tolerance,
            ),
          )
        ) {
          issues.push({
            type: "overlap",
            target: first.target,
            other: second.target,
          });
        }
      }
    }
    return issues;
  });
}
