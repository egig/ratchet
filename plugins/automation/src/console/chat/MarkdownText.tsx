import remarkGfm from 'remark-gfm';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import type { TextMessagePartComponent } from '@assistant-ui/react';

/**
 * Assistant text rendered as GitHub-flavored markdown (Q10) — no syntax highlighting; fenced
 * code renders as a plain scrollable `<pre>`. Styled to the console's token palette rather than
 * pulling in `@tailwindcss/typography`. Fenced code blocks stay a fixed dark chrome
 * (`bg-gray-900`/`text-gray-100`) in both themes — deliberate, matching the near-universal
 * always-dark-code-block convention, not a token gap.
 */
export const MarkdownText: TextMessagePartComponent = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    className="ratchet-markdown text-sm leading-relaxed text-foreground [&_a]:text-foreground [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-gray-900 [&_pre]:p-3 [&_pre]:text-xs [&_pre]:text-gray-100 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
  />
);
