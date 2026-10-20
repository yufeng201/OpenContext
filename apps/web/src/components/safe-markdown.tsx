import { markdownBlocks } from '../lib/markdown';
export function SafeMarkdown({ text }: { text: string }) {
  // Deliberately support only inert text structure: no raw HTML, URL, or executable content.
  return (
    <>
      {markdownBlocks(text).map((block, index) => {
        const line = block.text;
        if (block.kind === 'code')
          return (
            <pre key={index}>
              <code>{line}</code>
            </pre>
          );
        if (line.startsWith('### '))
          return <h4 key={index}>{line.slice(4)}</h4>;
        if (line.startsWith('## ')) return <h3 key={index}>{line.slice(3)}</h3>;
        if (line.startsWith('# ')) return <h2 key={index}>{line.slice(2)}</h2>;
        if (/^[-*] /.test(line))
          return (
            <p className="markdown-list" key={index}>
              • {line.slice(2)}
            </p>
          );
        return line ? (
          <p key={index}>{line}</p>
        ) : (
          <div className="markdown-space" key={index} />
        );
      })}
    </>
  );
}
