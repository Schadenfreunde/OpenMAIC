/**
 * Text chunking utility for splitting large documents into lesson-sized chunks.
 * Splits at natural boundaries (headings, paragraphs) to maintain readability.
 */

import { MAX_PDF_CONTENT_CHARS, MAX_LESSONS } from '@/lib/constants/generation';

export interface TextChunk {
  text: string;
  partNumber: number; // 1-indexed
  totalParts: number;
}

/**
 * Find the best split point at or before `maxPos` in `text`.
 * Prefers markdown headings, then paragraph breaks, then line breaks.
 */
function findSplitPoint(text: string, maxPos: number): number {
  // Don't search too far back — at most 20% of maxPos
  const searchStart = Math.max(0, maxPos - Math.floor(maxPos * 0.2));
  const searchRegion = text.slice(searchStart, maxPos);

  // Prefer markdown heading boundaries (# or ##)
  const headingMatch = searchRegion.lastIndexOf('\n#');
  if (headingMatch >= 0) {
    return searchStart + headingMatch;
  }

  // Then paragraph breaks (double newline)
  const paragraphMatch = searchRegion.lastIndexOf('\n\n');
  if (paragraphMatch >= 0) {
    return searchStart + paragraphMatch;
  }

  // Then any line break
  const lineMatch = searchRegion.lastIndexOf('\n');
  if (lineMatch >= 0) {
    return searchStart + lineMatch;
  }

  // Hard cut at maxPos
  return maxPos;
}

/**
 * Split text into chunks of at most `maxChars` characters each,
 * capped at `maxChunks` total chunks.
 *
 * If the text fits in a single chunk, returns it as-is (no-op).
 * The last chunk may be truncated if the document exceeds maxChars * maxChunks.
 */
export function chunkText(
  text: string,
  maxChars: number = MAX_PDF_CONTENT_CHARS,
  maxChunks: number = MAX_LESSONS,
): TextChunk[] {
  if (!text || text.length <= maxChars) {
    return [{ text, partNumber: 1, totalParts: 1 }];
  }

  const chunks: TextChunk[] = [];
  let offset = 0;

  while (offset < text.length && chunks.length < maxChunks) {
    const isLastAllowedChunk = chunks.length === maxChunks - 1;
    const remaining = text.length - offset;

    if (remaining <= maxChars) {
      // Remaining text fits in one chunk
      chunks.push({
        text: text.slice(offset),
        partNumber: chunks.length + 1,
        totalParts: 0, // filled in below
      });
      break;
    }

    if (isLastAllowedChunk) {
      // Last allowed chunk — take maxChars and truncate the rest
      chunks.push({
        text: text.slice(offset, offset + maxChars),
        partNumber: chunks.length + 1,
        totalParts: 0,
      });
      break;
    }

    // Find a natural split point
    const splitAt = findSplitPoint(text, offset + maxChars);
    chunks.push({
      text: text.slice(offset, splitAt),
      partNumber: chunks.length + 1,
      totalParts: 0,
    });
    offset = splitAt;

    // Skip leading whitespace in next chunk
    while (offset < text.length && text[offset] === '\n') {
      offset++;
    }
  }

  // Fill in totalParts
  const totalParts = chunks.length;
  for (const chunk of chunks) {
    chunk.totalParts = totalParts;
  }

  return chunks;
}
