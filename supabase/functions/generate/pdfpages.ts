// Finds which of the given pages of a PDF actually draw pictures, and cuts those pages into a small PDF the generator can show the AI
// (tables, diagrams and charts are often images with no text). A picture drawn on most pages (a logo) does not count.
// The pdf-lib module is passed in so this can be tested with node.
// deno-lint-ignore no-explicit-any
export async function pickImagePages(lib: any, bytes: Uint8Array, candidates: number[], max: number): Promise<{ pages: number[]; pdf: Uint8Array | null }> {
  const doc = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const count = doc.getPageCount(), image = lib.PDFName.of("Image"), text = new TextDecoder("latin1");
  // the pictures a page really draws: names used with the "Do" operator in its content, that are image objects (a page's resource list can name every picture in the file)
  const drawn = (n: number): string[] => {
    const node = doc.getPage(n - 1).node, xo = node.Resources()?.lookup(lib.PDFName.of("XObject"));
    if (!(xo instanceof lib.PDFDict)) return [];
    const parts = [node.Contents()].flat().filter(Boolean).map((c: unknown) => {
      const s = node.context.lookup(c);
      try { return text.decode(lib.decodePDFRawStream(s).decode()); } catch { return ""; }
    });
    const used = new Set([...parts.join("\n").matchAll(/\/([^\s\/\[\]<>()]+)\s+Do\b/g)].map((m) => m[1]));
    return [...used].flatMap((nm) => {
      const ref = xo.get(lib.PDFName.of(nm));
      return xo.context.lookup(ref)?.dict?.get(lib.PDFName.of("Subtype")) === image ? [String(ref)] : [];
    });
  };
  const per = Array.from({ length: count }, (_, i) => drawn(i + 1)), seen = new Map<string, number>();
  per.forEach((refs) => new Set(refs).forEach((r) => seen.set(r, (seen.get(r) ?? 0) + 1)));
  const decoration = (r: string) => count >= 4 && (seen.get(r) ?? 0) > count / 2;
  const pages = candidates.filter((n) => n >= 1 && n <= count && per[n - 1].some((r) => !decoration(r))).slice(0, max);
  if (!pages.length) return { pages: [], pdf: null };
  const out = await lib.PDFDocument.create();
  (await out.copyPages(doc, pages.map((n) => n - 1))).forEach((p: unknown) => out.addPage(p));
  return { pages, pdf: await out.save() };
}
