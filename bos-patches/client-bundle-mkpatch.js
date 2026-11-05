// Erzeugt die Patches am Client-Bundle von LibreChat v0.8.8 aus den Originaldateien des Images:
// - MyFilesModal: Tabelle "Meine Dateien" mit 100 statt 10 Zeilen je Seite.
// - eventSelection: Datenschutz und Nutzungsbedingungen in der Fusszeile in einem neuen Tab
//   (v0.8.8 uebergeht dort interface.*.openNewTab).
//   Dazu nennt der Anmeldeknopf eines MCP-Servers das System ("Anmeldung an Trac") statt der Domain der
//   Anmeldeseite, die bei allen Servern mit Keycloak gleich ist.
// - markdown: Links in Markdown-Artefakten in einem neuen Tab; ohne target oeffnet der Klick im iframe der Vorschau.
// - hooks (MarkdownImage): ![Name](/images/....mp4) als Videospieler statt <img>, fuer Videos, die
//   tool-files in die Antwort setzt.
// - index (BadgeRow): ein Klick auf einen Link zu /mcp-zugang/ oeffnet den Zugangsdaten-Dialog von LibreChat
//   (MCPConfigDialog) im Chat statt des Formulars in einem neuen Tab. Das Menue mit diesem Dialog fehlt bei
//   Presets mit Agent (MCPSelect nur mit showEphemeralBadges), deshalb eine eigene Komponente neben dem Menue.
//   Dieselbe Komponente zeigt diese Links und den Login-Flow-Link von Nextcloud als Knopf und laesst im
//   Preset-Menue Zeilenumbrueche der Beschreibung (SpecDescription) gelten.
// sw.js gibt jedem geaenderten Chunk eine Revision, sonst liefert der Service Worker den alten aus.
// Aufruf: docker run --rm -v "$PWD/patches/client-bundle:/out" --entrypoint node \
//           ghcr.io/librechat-ai/librechat:v0.8.8 /out/mkpatch.js /out
const fs = require('fs');
const zlib = require('zlib');
const dist = '/app/client/dist';
const out = process.argv[2];
const REVISION = 'bos-9';

const swap = (text, from, to, count = 1) => {
  const found = text.split(from).length - 1;
  if (found !== count) throw new Error(`${found}x statt ${count}x: ${from}`);
  return text.split(from).join(to);
};
const write = (name, text, compressed = true) => {
  fs.writeFileSync(`${out}/${name}`, text);
  if (!compressed) return;
  fs.writeFileSync(`${out}/${name}.gz`, zlib.gzipSync(text, { level: 9 }));
  fs.writeFileSync(`${out}/${name}.br`, zlib.brotliCompressSync(text));
};

const MCP_BUTTON_LINKS = '.markdown a[href*="/mcp-zugang/index.html?server="],.markdown a[href*="/login/v2/flow/"]';
const MCP_BUTTON_CSS = `${MCP_BUTTON_LINKS}{display:inline-block;margin:.25rem 0;padding:.5rem 1rem;border-radius:.5rem;`
  + 'background-color:#047857;background-color:rgb(var(--surface-submit));color:#fff!important;font-weight:500;'
  + 'text-decoration:none!important;cursor:pointer}'
  + MCP_BUTTON_LINKS.split(',').map((link) => `${link}:hover`).join(',')
  + '{background-color:#065f46;background-color:rgb(var(--surface-submit-hover))}'
  + '[role="option"] .break-words.text-xs.font-normal,[role="menuitem"] .break-words.text-xs.font-normal{white-space:pre-line}';
const MCP_DIALOG = 'function bosMcpDialog(){let{conversationId:e,storageContextKey:t,mcpServerManager:n}=ud()??{},'
  + 'r=(0,Q.useRef)(n);r.current=n,(0,Q.useEffect)(()=>{let e=e=>{if(e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey)return;'
  + 'let t=e.target?.closest?.(`a[href*="/mcp-zugang/index.html?server="]`);if(!t)return;'
  + 'let n=r.current?.getServerStatusIconProps?.(new URL(t.href).searchParams.get(`server`));n?.onConfigClick&&n.onConfigClick(e)};'
  + 'return document.addEventListener(`click`,e,!0),()=>document.removeEventListener(`click`,e,!0)},[]);'
  + 'let i=n?.getConfigDialogProps();return(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(`style`,{children:`' + MCP_BUTTON_CSS + '`}),'
  + 'i&&(0,$.jsx)(RD,{...i,conversationId:e,storageContextKey:t})]})}';

const chunks = {
  'index.CSEwt3Fy.js': (js) => swap(swap(js,
    'function eO(){let{selectableServers:e}=ud()?.mcpServerManager', `${MCP_DIALOG}function eO(){let{selectableServers:e}=ud()?.mcpServerManager`),
    'className:`relative flex flex-wrap items-center gap-2`,children:[e===!0&&(0,$.jsx)(HD,{}),',
    'className:`relative flex flex-wrap items-center gap-2`,children:[(0,$.jsx)(bosMcpDialog,{}),e===!0&&(0,$.jsx)(HD,{}),'),
  'MyFilesModal.D-V6_fYt.js': (js) => swap(js,
    'getPaginationRowModel:x(),onRowSelectionChange:l,',
    'getPaginationRowModel:x(),initialState:{pagination:{pageIndex:0,pageSize:100}},onRowSelectionChange:l,'),
  'eventSelection.xdAX3598.js': (js) => swap(swap(swap(js,
    'href:s.externalUrl,rel:`noreferrer`', 'href:s.externalUrl,target:`_blank`,rel:`noopener noreferrer`'),
    'href:c.externalUrl,rel:`noreferrer`', 'href:c.externalUrl,target:`_blank`,rel:`noopener noreferrer`'),
    'children:_(`com_ui_sign_in_to_domain`,{0:H})',
    'title:I&&L?H:void 0,children:I&&L?`Anmeldung an ${L.charAt(0).toUpperCase()+L.slice(1)}`:_(`com_ui_sign_in_to_domain`,{0:H})'),
  'markdown.N65uYq6U.js': (js) => swap(js,
    '}\\`);\n}\n<\\/script>',
    '}\\`);\ndocument.getElementById(\'content\').querySelectorAll(\'a\').forEach(function(a){a.target=\'_blank\';a.rel=\'noopener noreferrer\'});\n}\n<\\/script>'),
  'hooks.B1NLB7i6.js': (js) => swap(js,
    'return(0,J.jsx)(`img`,{src:s,alt:t,title:n,className:r,style:i})});m8.displayName=`MarkdownImage`',
    'return/\\.(mp4|m4v|webm|mov|ogv)([?#]|$)/i.test(s??``)?(0,J.jsx)(`video`,{src:s,controls:!0,preload:`metadata`,title:t||n,className:r,style:{maxWidth:`100%`,...i}}):(0,J.jsx)(`img`,{src:s,alt:t,title:n,className:r,style:i})});m8.displayName=`MarkdownImage`'),
};

let sw = fs.readFileSync(`${dist}/sw.js`, 'utf8');
for (const [name, patch] of Object.entries(chunks)) {
  write(name, patch(fs.readFileSync(`${dist}/assets/${name}`, 'utf8')));
  sw = swap(sw, `${name}",revision:null`, `${name}",revision:"${REVISION}"`);
}
write('sw.js', sw, false);
console.log('ok');
