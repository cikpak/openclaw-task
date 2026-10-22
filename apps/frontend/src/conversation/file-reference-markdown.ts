type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

/** Link public opaque references in prose without interpreting code or URLs. */
export function remarkFileReferences() {
  return function visit(node: MarkdownNode): void {
    if (
      ['link', 'linkReference', 'image', 'code', 'inlineCode', 'html'].includes(
        node.type,
      )
    )
      return;
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text' || !child.value) {
        visit(child);
        return [child];
      }
      const output: MarkdownNode[] = [];
      const text = child.value;
      let offset = 0;
      for (const match of text.matchAll(
        /(^|[\s([{"'])file:[A-Za-z0-9_-]{1,128}(?=$|[\s)\]}>"'.,;!?])/gu,
      )) {
        const start = match.index + match[1]!.length;
        if (start > offset)
          output.push({ type: 'text', value: text.slice(offset, start) });
        output.push({
          type: 'link',
          url: match[0].slice(match[1]!.length),
          children: [{ type: 'text', value: 'Download file' }],
        });
        offset = match.index + match[0].length;
      }
      if (!offset) return [child];
      if (offset < text.length)
        output.push({ type: 'text', value: text.slice(offset) });
      return output;
    });
  };
}
