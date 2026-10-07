import type { editor } from 'monaco-editor'

export const MONACO_THEME = 'code-intelligence-dark'

// Monaco's built-in vs-dark rules with the token colours that fall below WCAG 2.1 AA (4.5:1 on
// the editor background #1E1E1E) raised to readable values. The full rule list is kept here
// (inherit: false, as vs-dark itself does) so contrast.test.ts can check every colour in use.
export const monacoThemeData: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: false,
  rules: [
    { token: '', foreground: 'D4D4D4', background: '1E1E1E' },
    { token: 'invalid', foreground: 'F44747' },
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'variable', foreground: '74B0DF' },
    { token: 'variable.predefined', foreground: '7B9FE0' }, // vs-dark 4864AA (2.92:1)
    { token: 'variable.parameter', foreground: '9CDCFE' },
    { token: 'constant', foreground: '569CD6' },
    { token: 'comment', foreground: '6A9955' }, // vs-dark 608B4E (4.21:1)
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'number.hex', foreground: '5BB498' },
    { token: 'regexp', foreground: 'C47AA8' }, // vs-dark B46695 (4.19:1)
    { token: 'annotation', foreground: 'D67B7B' }, // vs-dark CC6666 (4.49:1)
    { token: 'type', foreground: '3DC9B0' },
    { token: 'delimiter', foreground: 'DCDCDC' },
    { token: 'delimiter.html', foreground: '8C8C8C' }, // vs-dark 808080 (4.22:1)
    { token: 'delimiter.xml', foreground: '8C8C8C' },
    { token: 'tag', foreground: '569CD6' },
    { token: 'tag.id.pug', foreground: '6F95D0' }, // vs-dark 4F76AC (3.59:1)
    { token: 'tag.class.pug', foreground: '6F95D0' },
    { token: 'meta.scss', foreground: 'A79873' },
    { token: 'meta.tag', foreground: 'CE9178' },
    { token: 'metatag', foreground: 'DD6A6F' },
    { token: 'metatag.content.html', foreground: '9CDCFE' },
    { token: 'metatag.html', foreground: '569CD6' },
    { token: 'metatag.xml', foreground: '569CD6' },
    { token: 'metatag.php', fontStyle: 'bold' },
    { token: 'key', foreground: '9CDCFE' },
    { token: 'string.key.json', foreground: '9CDCFE' },
    { token: 'string.value.json', foreground: 'CE9178' },
    { token: 'attribute.name', foreground: '9CDCFE' },
    { token: 'attribute.value', foreground: 'CE9178' },
    { token: 'attribute.value.number.css', foreground: 'B5CEA8' },
    { token: 'attribute.value.unit.css', foreground: 'B5CEA8' },
    { token: 'attribute.value.hex.css', foreground: 'D4D4D4' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'string.sql', foreground: 'FF6464' }, // vs-dark FF0000 (4.17:1)
    { token: 'keyword', foreground: '569CD6' },
    { token: 'keyword.flow', foreground: 'C586C0' },
    { token: 'keyword.json', foreground: 'CE9178' },
    { token: 'keyword.flow.scss', foreground: '569CD6' },
    { token: 'operator.scss', foreground: '909090' },
    { token: 'operator.sql', foreground: '778899' },
    { token: 'operator.swift', foreground: '909090' },
    { token: 'predefined.sql', foreground: 'FF00FF' },
  ],
  colors: {
    'editor.background': '#1E1E1E',
    'editor.foreground': '#D4D4D4',
    'editorLineNumber.foreground': '#8C8C8C',
    'editorLineNumber.activeForeground': '#C6C6C6',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editor.selectionHighlightBackground': '#ADD6FF26',
  },
}
