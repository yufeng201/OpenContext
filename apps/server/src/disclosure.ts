import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  ReadOptionsSchema,
  type ReadOptions,
  type ReadResult,
} from '@opencontext/contracts';
function* lines(text: string) {
  let start = 0,
    number = 1;
  while (true) {
    const newline = text.indexOf('\n', start),
      end = newline < 0 ? text.length : newline;
    yield { text: text.slice(start, end), start, end, number };
    if (newline < 0) return;
    start = end + 1;
    number++;
  }
}
function* headings(text: string) {
  let fence: string | null = null;
  for (const line of lines(text)) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fence) {
      if (
        f &&
        f[1]![0] === fence[0] &&
        f[1]!.length >= fence.length &&
        !f[2]!.trim()
      )
        fence = null;
      continue;
    }
    if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
      fence = f[1]!;
      continue;
    }
    const h = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line.text);
    if (h)
      yield {
        ...line,
        level: h[1]!.length,
        title: h[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim(),
      };
  }
}
/** Projection only, after object-size, integrity and current authorization checks. */
export function disclose(
  text: string,
  path: string,
  options: ReadOptions,
): Pick<ReadResult, 'text' | 'disclosure' | 'outline'> {
  if (!Value.Check(ReadOptionsSchema, options))
    throw new Error('INVALID_ARGUMENTS');
  if (!Object.keys(options).length) return { text };
  if (
    options.section &&
    (options.startLine !== undefined || options.maxLines !== undefined)
  )
    throw new Error('INVALID_ARGUMENTS');
  const markdown = /\.md$/i.test(path),
    budget = options.maxBytes ?? 8192;
  if (options.outline) {
    if (
      !markdown ||
      options.section ||
      options.maxLines !== undefined ||
      options.offsetBytes !== undefined
    )
      throw new Error('INVALID_ARGUMENTS');
    const outline: NonNullable<ReadResult['outline']> = [];
    let nextOutlineLine: number | null = null;
    for (const h of headings(text)) {
      if (h.number < (options.startLine ?? 1)) continue;
      const entry = {
        title: h.title.slice(0, 2000),
        line: h.number,
        level: h.level,
      };
      if (
        outline.length >= 200 ||
        Buffer.byteLength(JSON.stringify([...outline, entry])) > budget
      ) {
        if (!outline.length) throw new Error('BYTE_LIMIT');
        nextOutlineLine = h.number;
        break;
      }
      outline.push(entry);
    }
    return {
      text: '',
      outline,
      disclosure: {
        mode: 'outline',
        startLine: options.startLine ?? 1,
        fullBytes: Buffer.byteLength(text),
        selectedBytes: 0,
        returnedBytes: 0,
        offsetBytes: 0,
        nextOffsetBytes: null,
        nextOutlineLine,
        textHash: createHash('sha256').update('').digest('hex'),
      },
    };
  }
  let start = 0,
    end = text.length,
    startLine = 1;
  const mode = options.section
    ? 'section'
    : options.startLine !== undefined || options.maxLines !== undefined
      ? 'lines'
      : 'full';
  if (options.section) {
    if (!markdown) throw new Error('INVALID_ARGUMENTS');
    let selected: ReturnType<typeof headings> extends Generator<infer H>
      ? H
      : never;
    let count = 0,
      closed = false;
    for (const h of headings(text)) {
      if (h.title === options.section) {
        selected = h;
        count++;
        if (count === 1) {
          start = h.start;
          startLine = h.number;
        }
      } else if (count && !closed && h.level <= selected!.level) {
        end = Math.max(start, h.start - 1);
        closed = true;
      }
    }
    if (count !== 1) throw new Error('INVALID_ARGUMENTS');
  } else if (mode === 'lines') {
    const wanted = options.startLine ?? 1,
      limit = options.maxLines ?? 40;
    let found = false;
    for (const line of lines(text)) {
      if (line.number === wanted) {
        start = line.start;
        startLine = wanted;
        found = true;
      }
      if (found) {
        end = line.end;
        if (line.number >= wanted + limit - 1) break;
      }
    }
    if (!found) throw new Error('INVALID_ARGUMENTS');
  }
  const selected = Buffer.from(text.slice(start, end)),
    offset = options.offsetBytes ?? 0;
  if (
    offset > selected.length ||
    (offset < selected.length && (selected[offset]! & 0xc0) === 0x80)
  )
    throw new Error('INVALID_ARGUMENTS');
  let stop = Math.min(selected.length, offset + budget);
  while (stop < selected.length && (selected[stop]! & 0xc0) === 0x80) stop--;
  const fragment = selected.subarray(offset, stop).toString('utf8');
  return {
    text: fragment,
    disclosure: {
      mode,
      startLine,
      fullBytes: Buffer.byteLength(text),
      selectedBytes: selected.length,
      returnedBytes: stop - offset,
      offsetBytes: offset,
      nextOffsetBytes: stop < selected.length ? stop : null,
      textHash: createHash('sha256').update(fragment).digest('hex'),
    },
  };
}
