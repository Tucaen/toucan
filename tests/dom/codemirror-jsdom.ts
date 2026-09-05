/*
 * CodeMirror 6 measures text through DOM ranges, which jsdom lays out as nothing at all: it has no
 * `Range.getClientRects`, and a missing method - unlike an empty rect - throws inside the editor's
 * measure pass. These stubs give layout-free answers so an editor can mount, hold a document and
 * take edits under test; nothing here makes geometry meaningful.
 */
const emptyRect = (): DOMRect => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({})
})

const emptyRects = (): DOMRectList =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList

if (typeof Range !== 'undefined') {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = emptyRect
}
if (typeof document !== 'undefined' && !document.elementFromPoint) {
  document.elementFromPoint = () => null
}
