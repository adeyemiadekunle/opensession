import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./lib/utils";

/** Element styles for the agent's replies: the design tokens, sized for the chat column. Raw HTML
 *  in the text is not rendered (react-markdown's default), so a reply can't inject markup. */
const components: Components = {
  p: ({ children }) => <p className="m-0">{children}</p>,
  h1: ({ children }) => <h3 className="m-0 text-[16px] font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="m-0 text-[15.5px] font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="m-0 text-[15px] font-semibold">{children}</h4>,
  h4: ({ children }) => <h4 className="m-0 text-[15px] font-semibold">{children}</h4>,
  ul: ({ children }) => <ul className="m-0 flex list-disc flex-col gap-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 [&>p]:inline">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="m-0 border-l-2 border-input pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-1 border-0 border-t border-border" />,
  pre: ({ children }) => (
    <pre className="m-0 max-h-80 overflow-auto rounded-md border border-border bg-code px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    <code className={cn("rounded bg-sunken px-1 py-px font-mono text-[0.88em]", className)}>{children}</code>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-input px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-border px-2 py-1 align-top">{children}</td>,
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
