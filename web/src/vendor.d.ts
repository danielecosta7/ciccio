declare module 'mammoth/mammoth.browser.js' {
  const mammoth: { convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string; messages: unknown[] }> };
  export default mammoth;
}
