// Uploads from the browser.

/**
 * Ending of the hidden file an upload is written to before it gets its real
 * name (compressions write their output to one too). Folder listings skip
 * these, so half-written files never show up.
 */
export const UPLOAD_PART_SUFFIX = '.med-upload.part'
