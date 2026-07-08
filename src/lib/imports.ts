export function extractImports(code: string): string[] {
  const imports = new Set<string>();
  const source = stripJsComments(code);
  const patterns = [
    /import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /export\s+.+?\s+from\s+["']([^"']+)["']/g,
    /require\(["']([^"']+)["']\)/g
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) imports.add(match[1]);
    }
  }

  return [...imports].slice(0, 40);
}

function stripJsComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
