import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
} from '@aws-sdk/client-sesv2';
import type {
  SesSendRawPayload,
  SesSendSimplePayload,
} from './ses-send-driver';
import { SesSendSdkDriver } from './ses-send-sdk.driver';

const FROM = 'Awa Diallo <contact@boutique-awa.gn>';
const TO = 'client@exemple.gn';
const SUBJECT = 'Votre commande est prête';

function simplePayload(
  overrides: Partial<Omit<SesSendSimplePayload, 'kind'>> = {},
): SesSendSimplePayload {
  return {
    kind: 'simple',
    from: FROM,
    to: TO,
    subject: SUBJECT,
    html: '<p>Bonjour</p>',
    ...overrides,
  };
}

function rawPayload(
  overrides: Partial<Omit<SesSendRawPayload, 'kind'>> = {},
): SesSendRawPayload {
  return {
    kind: 'raw',
    from: FROM,
    to: TO,
    subject: SUBJECT,
    raw: `From: ${FROM}\r\nSubject: ${SUBJECT}\r\n\r\nBonjour`,
    ...overrides,
  };
}

describe('SesSendSdkDriver', () => {
  let commands: SendEmailCommand[];

  function driverWith(configurationSet?: string): SesSendSdkDriver {
    return new SesSendSdkDriver({
      region: 'eu-west-3',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      configurationSet,
    });
  }

  /** Entrée réellement remise au `SendEmailCommand` du dernier envoi. */
  function lastInput(): SendEmailCommandInput {
    return commands[commands.length - 1].input;
  }

  beforeEach(() => {
    commands = [];

    jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(((
      command: SendEmailCommand,
    ) => {
      commands.push(command);
      return Promise.resolve({ MessageId: 'ses-msg-1' });
    }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('contenu Simple', () => {
    // Garde-fou de non-régression : la requête du canal API doit rester
    // exactement celle d'avant l'introduction du contenu Raw. `toEqual` sur
    // l'entrée entière casse aussi bien sur un champ ajouté que retiré.
    it('builds exactly the pre-Raw SendEmail request', async () => {
      await driverWith().send(simplePayload({ text: 'Bonjour' }));

      expect(commands).toHaveLength(1);
      expect(commands[0]).toBeInstanceOf(SendEmailCommand);
      expect(lastInput()).toEqual({
        FromEmailAddress: FROM,
        Destination: { ToAddresses: [TO] },
        Content: {
          Simple: {
            Subject: { Data: SUBJECT, Charset: 'UTF-8' },
            Body: {
              Html: { Data: '<p>Bonjour</p>', Charset: 'UTF-8' },
              Text: { Data: 'Bonjour', Charset: 'UTF-8' },
            },
          },
        },
      });
    });

    it('omits the body variant that was not provided', async () => {
      await driverWith().send(
        simplePayload({ html: undefined, text: 'Salut' }),
      );

      expect(lastInput().Content?.Simple?.Body).toEqual({
        Text: { Data: 'Salut', Charset: 'UTF-8' },
      });
    });

    it('never sets Content.Raw', async () => {
      await driverWith().send(simplePayload());

      expect(lastInput().Content?.Raw).toBeUndefined();
    });

    it('applies the driver configuration set', async () => {
      await driverWith('zendou').send(simplePayload());

      expect(lastInput().ConfigurationSetName).toBe('zendou');
    });

    it('lets the payload override the configuration set', async () => {
      await driverWith('zendou').send(
        simplePayload({ configurationSet: 'zendou-test' }),
      );

      expect(lastInput().ConfigurationSetName).toBe('zendou-test');
    });
  });

  describe('contenu Raw', () => {
    it('sends the MIME bytes as Content.Raw.Data', async () => {
      const raw = 'Subject: Facture\r\n\r\nMerci';

      await driverWith().send(rawPayload({ raw }));

      expect(lastInput().Content?.Raw?.Data).toEqual(Buffer.from(raw, 'utf8'));
      expect(lastInput().Content?.Simple).toBeUndefined();
    });

    // Le pivot anti-fuite de Bcc : SES ne livre qu'aux adresses de
    // `Destination`. Un `Bcc:` resté dans les octets bruts ne peut donc pas
    // provoquer d'envoi, et l'éventail multi-destinataires reste exact.
    it('always provides Destination.ToAddresses with the single recipient', async () => {
      await driverWith().send(
        rawPayload({
          to: 'comptabilite@exemple.gn',
          raw: 'To: client@exemple.gn\r\nBcc: espion@ailleurs.gn\r\n\r\nBonjour',
        }),
      );

      expect(lastInput().Destination).toEqual({
        ToAddresses: ['comptabilite@exemple.gn'],
      });
      expect(lastInput().FromEmailAddress).toBe(FROM);
    });

    it('passes a Buffer straight through, without recomposing it', async () => {
      const raw = Buffer.from(
        'Content-Type: multipart/mixed; boundary="f"\r\n\r\n--f--\r\n',
        'utf8',
      );

      await driverWith().send(rawPayload({ raw }));

      // Identité, pas seulement égalité : aucune copie, aucune réécriture.
      expect(lastInput().Content?.Raw?.Data).toBe(raw);
    });

    it('keeps a UTF-8 message byte-identical', async () => {
      const raw = 'Subject: Facture réglée\r\n\r\nMerci beaucoup — à bientôt';

      await driverWith().send(rawPayload({ raw }));

      const data = lastInput().Content?.Raw?.Data;
      expect(data).toBeDefined();
      expect(Buffer.from(data ?? []).toString('utf8')).toBe(raw);
    });

    it('applies the configuration set like the Simple path', async () => {
      await driverWith('zendou').send(rawPayload());

      expect(lastInput().ConfigurationSetName).toBe('zendou');
    });

    it('returns the SES message id', async () => {
      await expect(driverWith().send(rawPayload())).resolves.toEqual({
        messageId: 'ses-msg-1',
      });
    });
  });
});
