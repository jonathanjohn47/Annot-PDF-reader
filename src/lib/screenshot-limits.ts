// Upper bound on screenshots attached to one question, to keep the prompt and image reads small.
export const MAX_SCREENSHOTS = 6;

// Upper bound on files/images the user attaches from disk to one chat message.
export const MAX_ATTACHMENTS = 6;
// Upper size of a single attached file, in bytes.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
