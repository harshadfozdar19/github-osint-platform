import {
  classifyContentFile,
  isContentBearingFile,
} from './content-file-classifier.util';

describe('classifyContentFile', () => {
  it('classifies locale directory files', () => {
    expect(classifyContentFile('src/locales/en.json')).toBe('locale');
    expect(classifyContentFile('i18n/messages.json')).toBe('locale');
    expect(classifyContentFile('translations/fr/common.json')).toBe('locale');
  });

  it('classifies gettext locale files by extension', () => {
    expect(classifyContentFile('locale/fr/LC_MESSAGES/messages.po')).toBe(
      'locale',
    );
    expect(classifyContentFile('src/messages.pot')).toBe('locale');
  });

  it('classifies well-known top-level locale filenames', () => {
    expect(classifyContentFile('en.json')).toBe('locale');
    expect(classifyContentFile('src/strings.json')).toBe('locale');
  });

  it('classifies template directories and extensions', () => {
    expect(classifyContentFile('templates/welcome-email.html')).toBe(
      'template',
    );
    expect(classifyContentFile('src/emails/receipt.hbs')).toBe('template');
    expect(classifyContentFile('notifications.ejs')).toBe('template');
    expect(classifyContentFile('newsletter.mjml')).toBe('template');
  });

  it('classifies legal filenames', () => {
    expect(classifyContentFile('TERMS.md')).toBe('legal');
    expect(classifyContentFile('privacy-policy.html')).toBe('legal');
    expect(classifyContentFile('src/legal/eula.txt')).toBe('legal');
  });

  it('classifies README and generic prose extensions as docs', () => {
    expect(classifyContentFile('README.md')).toBe('docs');
    expect(classifyContentFile('readme.rst')).not.toBe(null); // still README-shaped
    expect(classifyContentFile('docs/getting-started.md')).toBe('docs');
    expect(classifyContentFile('notes.txt')).toBe('docs');
  });

  it('excludes universal boilerplate files even though they are prose', () => {
    expect(classifyContentFile('LICENSE')).toBeNull();
    expect(classifyContentFile('LICENSE.md')).toBeNull();
    expect(classifyContentFile('CHANGELOG.md')).toBeNull();
    expect(classifyContentFile('CONTRIBUTING.md')).toBeNull();
  });

  it('returns null for generic source/config files', () => {
    expect(classifyContentFile('package.json')).toBeNull();
    expect(classifyContentFile('tsconfig.json')).toBeNull();
    expect(classifyContentFile('src/index.ts')).toBeNull();
    expect(classifyContentFile('src/components/Login.tsx')).toBeNull();
    expect(classifyContentFile('node_modules/dep/package.json')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(classifyContentFile('SRC/LOCALES/EN.JSON')).toBe('locale');
    expect(classifyContentFile('Readme.MD')).toBe('docs');
  });
});

describe('isContentBearingFile', () => {
  it('mirrors classifyContentFile as a boolean', () => {
    expect(isContentBearingFile('src/locales/en.json')).toBe(true);
    expect(isContentBearingFile('src/index.ts')).toBe(false);
  });
});
