/** What a path's extension stands for, as served; anything else is a plain byte stream. */
const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
    aac: "audio/aac",
    avif: "image/avif",
    bmp: "image/bmp",
    cjs: "text/javascript",
    css: "text/css",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    epub: "application/epub+zip",
    flac: "audio/flac",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    m4a: "audio/mp4",
    m4v: "video/mp4",
    map: "application/json",
    markdown: "text/markdown",
    md: "text/markdown",
    mjs: "text/javascript",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    oga: "audio/ogg",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    ogg: "audio/ogg",
    ogv: "video/ogg",
    opus: "audio/ogg",
    otf: "font/otf",
    pdf: "application/pdf",
    png: "image/png",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    svg: "image/svg+xml",
    tsv: "text/tab-separated-values",
    ttf: "font/ttf",
    txt: "text/plain",
    wasm: "application/wasm",
    wav: "audio/wav",
    webm: "video/webm",
    webmanifest: "application/manifest+json",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    zip: "application/zip",
};

/** The media type a file is served with, decided by its path's extension alone. */
export function mediaTypeForPath(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return "application/octet-stream";
    const extension = name.slice(dot + 1).toLowerCase();
    return (
        (Object.hasOwn(MIME_TYPES_BY_EXTENSION, extension)
            ? MIME_TYPES_BY_EXTENSION[extension]
            : undefined) ?? "application/octet-stream"
    );
}
