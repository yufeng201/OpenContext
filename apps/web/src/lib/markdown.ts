/** Inert structure only. Code fences never activate HTML, links or instructions. */
export function markdownBlocks(
  text: string,
): Array<{ kind: 'text' | 'code'; text: string }> {
  const blocks: Array<{ kind: 'text' | 'code'; text: string }> = [];
  let fence: string | null = null;
  let code: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        match &&
        match[1]![0] === fence[0] &&
        match[1]!.length >= fence.length &&
        !match[2]!.trim()
      ) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = [];
        fence = null;
      } else code.push(line);
    } else if (match && !(match[1]![0] === '`' && match[2]!.includes('`'))) {
      fence = match[1]!;
    } else blocks.push({ kind: 'text', text: line });
  }
  if (fence) blocks.push({ kind: 'code', text: code.join('\n') });
  return blocks;
}
