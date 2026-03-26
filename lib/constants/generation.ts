/**
 * Constants for PDF content generation
 * Shared between client and server code
 */

// PDF content truncation limit (characters)
export const MAX_PDF_CONTENT_CHARS = 50000;

// Maximum number of images to send as vision content parts
export const MAX_VISION_IMAGES = 20;

// Multi-lesson safety limits
export const MAX_LESSONS = 12; // Max lessons (text chunks) per classroom
export const MAX_TOTAL_SCENES = 100; // Max scenes across all lessons
