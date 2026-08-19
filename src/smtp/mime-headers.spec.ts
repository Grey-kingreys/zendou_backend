import { createHash } from 'node:crypto';

import {
  attachmentWithoutBccFixture,
  base64SubjectFixture,
  bccWithAttachmentFixture,
  duplicateFromFixture,
  emptySubjectFixture,
  encodedDisplayNameFixture,
  foldedEncodedSubjectFixture,
  foldedSubjectFixture,
  headersOnlyFixture,
  invalidFromFixture,
  longSubjectFixture,
  mboxPrefixFixture,
  mixedLineEndingsFixture,
  multipleAddressesInFromFixture,
  orphanFoldFixture,
  quotedCommaDisplayNameFixture,
  quotedPrintableSubjectFixture,
  resentHeadersFixture,
  withoutFromFixture,
  withoutSubjectFixture,
} from './fixtures';
import {
  analyzeRawMessage,
  decodeEncodedWords,
  isStrippedHeader,
  MIME_REFUSAL,
  parseMimeHeaders,
  splitRawMessage,
} from './mime-headers';
import type { MimeHeaderAnalysis } from './mime-headers';

const sha256 = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

/** Restreint le résultat à sa branche acceptée, en échouant sinon. */
function accepted(raw: Buffer): MimeHeaderAnalysis {
  const result = analyzeRawMessage(raw);

  if (!result.ok) {
    throw new Error(`message refusé : ${result.reason}`);
  }

  return result;
}

describe('splitRawMessage', () => {
  it('cuts at the first blank line and can be reassembled byte for byte', () => {
    const { raw } = quotedPrintableSubjectFixture();
    const parts = splitRawMessage(raw);

    expect(parts.separator.toString('latin1')).toBe('\r\n');
    expect(parts.headers.toString('utf8')).toContain('Subject:');
    expect(parts.body.toString('utf8')).toBe(
      'Bonjour,\r\n\r\nVotre facture est disponible.\r\n',
    );
    expect(
      Buffer.concat([parts.headers, parts.separator, parts.body]).equals(raw),
    ).toBe(true);
  });

  it('tolerates a LF LF separator', () => {
    const raw = Buffer.from('Subject: Ping\nFrom: a@b.gn\n\ncorps\n', 'utf8');
    const parts = splitRawMessage(raw);

    expect(parts.headers.toString('utf8')).toBe(
      'Subject: Ping\nFrom: a@b.gn\n',
    );
    expect(parts.separator.toString('latin1')).toBe('\n');
    expect(parts.body.toString('utf8')).toBe('corps\n');
  });

  it('tolerates the mixed CRLF LF and LF CRLF separators', () => {
    const crlfThenLf = splitRawMessage(Buffer.from('A: 1\r\n\ncorps', 'utf8'));
    const lfThenCrlf = splitRawMessage(Buffer.from('A: 1\n\r\ncorps', 'utf8'));

    expect(crlfThenLf.body.toString('utf8')).toBe('corps');
    expect(lfThenCrlf.body.toString('utf8')).toBe('corps');
  });

  it('stops at the FIRST blank line, leaving multipart part headers in the body', () => {
    const { raw, body } = bccWithAttachmentFixture();
    const parts = splitRawMessage(raw);

    expect(parts.body.equals(body)).toBe(true);
    // Les lignes « Content-Type: » des parties restent dans le corps.
    expect(parts.headers.toString('utf8')).not.toContain('application/pdf');
    expect(parts.body.toString('utf8')).toContain('Content-Type: text/plain');
  });

  it('treats a message without a blank line as headers only', () => {
    const { raw } = headersOnlyFixture();
    const parts = splitRawMessage(raw);

    expect(parts.headers.equals(raw)).toBe(true);
    expect(parts.separator).toHaveLength(0);
    expect(parts.body).toHaveLength(0);
  });

  it('treats a message starting with a blank line as having no headers', () => {
    const parts = splitRawMessage(Buffer.from('\r\ncorps seul\r\n', 'utf8'));

    expect(parts.headers).toHaveLength(0);
    expect(parts.body.toString('utf8')).toBe('corps seul\r\n');
  });
});

describe('parseMimeHeaders', () => {
  it('reads names, lower-cased keys and values', () => {
    const { headers } = splitRawMessage(base64SubjectFixture().raw);
    const fields = parseMimeHeaders(headers);

    expect(fields?.map((field) => field.name)).toEqual([
      'From',
      'To',
      'Subject',
      'Message-ID',
    ]);
    expect(fields?.map((field) => field.key)).toEqual([
      'from',
      'to',
      'subject',
      'message-id',
    ]);
    expect(fields?.[1].value).toBe('client@exemple.gn');
  });

  it('unfolds a header folded over three lines', () => {
    const { headers } = splitRawMessage(foldedSubjectFixture().raw);
    const fields = parseMimeHeaders(headers);
    const subject = fields?.find((field) => field.key === 'subject');

    expect(subject?.value).toBe(
      'Facture 42 pour la Société Guinéenne de Distribution',
    );
  });

  it('keeps the whitespace that followed a fold, tab included', () => {
    const { headers } = splitRawMessage(foldedSubjectFixture().raw);
    const fields = parseMimeHeaders(headers);
    const to = fields?.find((field) => field.key === 'to');

    expect(to?.value).toBe(
      'comptabilite@societe-guineenne.gn,\tdirection@societe-guineenne.gn',
    );
  });

  it('covers the header block with no gap and no overlap', () => {
    const { headers } = splitRawMessage(foldedSubjectFixture().raw);
    const fields = parseMimeHeaders(headers) ?? [];

    expect(fields[0].start).toBe(0);
    expect(fields[fields.length - 1].end).toBe(headers.length);

    for (let index = 1; index < fields.length; index++) {
      expect(fields[index].start).toBe(fields[index - 1].end);
    }
  });

  it('returns an empty list for an empty header block', () => {
    expect(parseMimeHeaders(Buffer.alloc(0))).toEqual([]);
  });

  it('rejects a line that is neither a field nor a continuation', () => {
    const { headers } = splitRawMessage(mboxPrefixFixture().raw);

    expect(parseMimeHeaders(headers)).toBeNull();
  });

  it('rejects a continuation with no field to continue', () => {
    const { headers } = splitRawMessage(orphanFoldFixture().raw);

    expect(parseMimeHeaders(headers)).toBeNull();
  });

  it('rejects an empty field name', () => {
    expect(parseMimeHeaders(Buffer.from(': valeur\r\n', 'utf8'))).toBeNull();
  });
});

describe('decodeEncodedWords', () => {
  it('decodes a quoted-printable encoded word', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?Facture_n=C2=B0_42?=')).toBe(
      'Facture n° 42',
    );
  });

  it('decodes a base64 UTF-8 encoded word', () => {
    expect(decodeEncodedWords('=?UTF-8?B?Q29tbWFuZGUgcHLDqnRl?=')).toBe(
      'Commande prête',
    );
  });

  it('leaves a plain value untouched', () => {
    expect(decodeEncodedWords('Facture 42')).toBe('Facture 42');
  });

  it('leaves an unknown encoding untouched rather than throwing', () => {
    expect(decodeEncodedWords('=?UTF-8?X?zzz?=')).toBe('=?UTF-8?X?zzz?=');
  });
});

describe('isStrippedHeader', () => {
  it.each(['bcc', 'sender', 'return-path', 'resent-from', 'resent-bcc'])(
    'strips « %s »',
    (key) => {
      expect(isStrippedHeader(key)).toBe(true);
    },
  );

  it.each(['message-id', 'from', 'to', 'cc', 'reply-to', 'subject'])(
    'keeps « %s »',
    (key) => {
      expect(isStrippedHeader(key)).toBe(false);
    },
  );
});

describe('analyzeRawMessage — sujet', () => {
  it('decodes a quoted-printable subject', () => {
    expect(accepted(quotedPrintableSubjectFixture().raw).subject).toBe(
      'Facture n° 42 pour la Société',
    );
  });

  it('decodes a base64 UTF-8 subject', () => {
    expect(accepted(base64SubjectFixture().raw).subject).toBe(
      'Félicitations : votre commande est prête',
    );
  });

  it('unfolds a subject folded over three lines', () => {
    expect(accepted(foldedSubjectFixture().raw).subject).toBe(
      'Facture 42 pour la Société Guinéenne de Distribution',
    );
  });

  it('joins three folded encoded words without the folding whitespace', () => {
    expect(accepted(foldedEncodedSubjectFixture().raw).subject).toBe(
      'Félicitations : votre commande est prête',
    );
  });

  it('reports a missing Subject as undefined, so the caller can fall back', () => {
    const result = accepted(withoutSubjectFixture().raw);

    expect(result.subject).toBeUndefined();
    expect(result.from?.address).toBe('contact@boutique-awa.gn');
  });

  it('reports an empty Subject as an empty string', () => {
    expect(accepted(emptySubjectFixture().raw).subject).toBe('');
  });

  it('never truncates the subject — that is a storage choice of the caller', () => {
    const subject = accepted(longSubjectFixture().raw).subject ?? '';

    expect(subject.length).toBeGreaterThan(300);
    expect(subject.endsWith('Distribution.')).toBe(true);
  });
});

describe('analyzeRawMessage — From', () => {
  it('parses the header From through parseEmailAddress', () => {
    expect(accepted(quotedPrintableSubjectFixture().raw).from).toEqual({
      name: 'Awa Diallo',
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('parses a bare address', () => {
    expect(accepted(base64SubjectFixture().raw).from).toEqual({
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('decodes an encoded display name', () => {
    expect(accepted(encodedDisplayNameFixture().raw).from).toEqual({
      name: 'Awa Diallô',
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('does not split a quoted display name on its comma', () => {
    expect(accepted(quotedCommaDisplayNameFixture().raw).from).toEqual({
      name: 'Diallo, Awa',
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('reports a missing From as undefined, so the caller can inject the envelope one', () => {
    const result = accepted(withoutFromFixture().raw);

    expect(result.from).toBeUndefined();
    expect(result.subject).toBe('Facture 42');
  });

  it('refuses two From headers', () => {
    expect(analyzeRawMessage(duplicateFromFixture().raw)).toEqual({
      ok: false,
      reason: MIME_REFUSAL.MULTIPLE_FROM,
    });
  });

  it('refuses two addresses inside a single From header', () => {
    expect(analyzeRawMessage(multipleAddressesInFromFixture().raw)).toEqual({
      ok: false,
      reason: MIME_REFUSAL.MULTIPLE_FROM,
    });
  });

  it('refuses an unreadable From', () => {
    expect(analyzeRawMessage(invalidFromFixture().raw)).toEqual({
      ok: false,
      reason: MIME_REFUSAL.INVALID_FROM,
    });
  });

  it('refuses a malformed header block', () => {
    expect(analyzeRawMessage(mboxPrefixFixture().raw)).toEqual({
      ok: false,
      reason: MIME_REFUSAL.MALFORMED_HEADERS,
    });
    expect(analyzeRawMessage(orphanFoldFixture().raw)).toEqual({
      ok: false,
      reason: MIME_REFUSAL.MALFORMED_HEADERS,
    });
  });
});

describe('analyzeRawMessage — réécriture des octets', () => {
  it('removes a folded Bcc and leaves the body hash-identical', () => {
    const fixture = bccWithAttachmentFixture();
    const result = accepted(fixture.raw);

    expect(result.strippedHeaders).toEqual(['Bcc']);
    expect(result.raw.toString('utf8')).not.toContain('comptabilite@');
    // Les DEUX lignes du Bcc replié disparaissent.
    expect(result.raw.toString('utf8')).not.toContain('archives@');

    const rewrittenBody = splitRawMessage(result.raw).body;

    expect(sha256(rewrittenBody)).toBe(sha256(fixture.body));
    expect(rewrittenBody.equals(fixture.body)).toBe(true);
  });

  it('produces exactly the same message as the one sent without a Bcc', () => {
    const result = accepted(bccWithAttachmentFixture().raw);

    expect(result.raw.equals(attachmentWithoutBccFixture().raw)).toBe(true);
  });

  it('removes Sender, Return-Path and every Resent-*, and keeps Message-ID', () => {
    const result = accepted(resentHeadersFixture().raw);
    const rewritten = result.raw.toString('utf8');

    expect(result.strippedHeaders).toEqual([
      'Return-Path',
      'Sender',
      'Resent-From',
      'Resent-Date',
      'Resent-Bcc',
      'Resent-Message-ID',
    ]);
    expect(rewritten).not.toMatch(/^Return-Path:/m);
    expect(rewritten).not.toMatch(/^Sender:/m);
    expect(rewritten).not.toMatch(/^Resent-/m);
    expect(rewritten).not.toContain('veille@boutique-awa.gn');
    expect(rewritten).toContain('Message-ID: <conserve-1@boutique-awa.gn>\r\n');
    expect(rewritten).toContain('Reply-To: sav@boutique-awa.gn\r\n');
  });

  it('returns the input byte for byte when nothing has to be stripped', () => {
    const { raw } = quotedPrintableSubjectFixture();
    const result = accepted(raw);

    expect(result.strippedHeaders).toEqual([]);
    expect(result.raw.equals(raw)).toBe(true);
  });

  it('preserves each kept header line ending on a mixed CRLF/LF message', () => {
    const fixture = mixedLineEndingsFixture();
    const result = accepted(fixture.raw);

    expect(result.subject).toBe('Relevé du mois');
    expect(result.strippedHeaders).toEqual(['Bcc']);
    expect(result.raw.toString('utf8')).toBe(
      'From: Awa Diallo <contact@boutique-awa.gn>\r\n' +
        'To: comptabilite@societe-guineenne.gn\n' +
        'Subject: Relevé\n' +
        ' du mois\r\n' +
        'Message-ID: <mixte-1@boutique-awa.gn>\n' +
        '\n' +
        'Première ligne\nDeuxième ligne\r\n',
    );
    expect(sha256(splitRawMessage(result.raw).body)).toBe(sha256(fixture.body));
  });

  it('strips a Bcc from a message that has no body at all', () => {
    const result = accepted(headersOnlyFixture().raw);

    expect(result.strippedHeaders).toEqual(['Bcc']);
    expect(result.raw.toString('utf8')).toBe(
      'From: Awa Diallo <contact@boutique-awa.gn>\r\nSubject: Ping\r\n',
    );
  });
});
