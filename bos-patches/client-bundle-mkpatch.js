// Erzeugt die Patches am Client-Bundle von LibreChat v0.8.9 aus den Originaldateien des Images:
// - AnalyticsConsent (Fusszeile im Chat) und index (Anmeldeseite: Linkzeile und Zustimmungstext): Datenschutz
//   und Nutzungsbedingungen in einem neuen Tab (v0.8.9 uebergeht dort interface.*.openNewTab).
// - hosts (ToolCall): der Anmeldeknopf eines MCP-Servers nennt das System ("Anmeldung an Trac") statt der
//   Domain der Anmeldeseite, die bei allen Servern mit Keycloak gleich ist.
// - markdown: Links in Markdown-Artefakten in einem neuen Tab; ohne target oeffnet der Klick im iframe der Vorschau.
// - ToolMermaidArtifact (MarkdownImage): ![Name](/images/....mp4) als Videospieler statt <img>, fuer Videos, die
//   tool-files in die Antwort setzt.
//   Bilder und Videos von einem anderen Server als LibreChat laedt erst ein Klick auf einen Platzhalter
//   ("Bild von <Host> laden"): sonst holt der Browser sie beim Anzeigen der Antwort, und eine Adresse mit
//   Daten aus dem Chat, die eine Webseite dem Modell untergeschoben hat, ginge ohne Klick hinaus.
// - index (Eingabefeld): ein Klick auf einen Link zu /mcp-zugang/ oeffnet den Zugangsdaten-Dialog von LibreChat
//   (MCPConfigDialog, den das Eingabefeld rendert) im Chat statt des Formulars in einem neuen Tab.
//   Dieselbe Komponente zeigt diese Links und den Login-Flow-Link von Nextcloud als Knopf und laesst im
//   Preset-Menue Zeilenumbrueche der Beschreibung gelten.
//   Dazu faellt auf der Startseite eines Chats die Zeile "Kontakt:" (AgentContact) unter der Beschreibung weg.
// sw.js gibt jedem geaenderten Chunk eine Revision, sonst liefert der Service Worker den alten aus.
// Aufruf: docker run --rm -v "$PWD/patches/client-bundle:/out" --entrypoint node \
//           ghcr.io/librechat-ai/librechat:v0.8.9 /out/mkpatch.js /out
const fs = require('fs');
const zlib = require('zlib');
const dist = '/app/client/dist';
const out = process.argv[2];
const REVISION = 'bos-13';

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
const PRESET_DESCRIPTION = '.break-words.text-xs.font-normal';
const MCP_BUTTON_CSS = `${MCP_BUTTON_LINKS}{display:inline-block;margin:.25rem 0;padding:.5rem 1rem;border-radius:.5rem;`
  + 'background-color:#047857;background-color:rgb(var(--surface-submit));color:#fff!important;font-weight:500;'
  + 'text-decoration:none!important;cursor:pointer}'
  + MCP_BUTTON_LINKS.split(',').map((link) => `${link}:hover`).join(',')
  + '{background-color:#065f46;background-color:rgb(var(--surface-submit-hover))}'
  + ['[role="option"]', '[role="menuitem"]', '[aria-setsize]'].map((item) => `${item} ${PRESET_DESCRIPTION}`).join(',')
  + '{white-space:pre-line}';
const MCP_DIALOG = 'function bosMcpDialog({manager:n}){let r=(0,Q.useRef)(n);r.current=n,(0,Q.useEffect)(()=>{'
  + 'let e=e=>{if(e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey)return;'
  + 'let t=e.target?.closest?.(`a[href*="/mcp-zugang/index.html?server="]`);if(!t)return;'
  + 'let n=r.current?.getServerStatusIconProps?.(new URL(t.href).searchParams.get(`server`));n?.onConfigClick&&n.onConfigClick(e)};'
  + 'return document.addEventListener(`click`,e,!0),()=>document.removeEventListener(`click`,e,!0)},[]);'
  + 'return(0,$.jsx)(`style`,{children:`' + MCP_BUTTON_CSS + '`})}';
const VIDEO = '/\\.(mp4|m4v|webm|mov|ogv)([?#]|$)/i';

const chunks = {
  'index.ggnZObIL.js': (js) => swap(swap(swap(swap(swap(js,
    'href:n,rel:`noreferrer`,children:t(`com_ui_privacy_policy`)',
    'href:n,target:`_blank`,rel:`noopener noreferrer`,children:t(`com_ui_privacy_policy`)', 2),
    'href:r,rel:`noreferrer`,children:t(`com_ui_terms_of_service`)',
    'href:r,target:`_blank`,rel:`noopener noreferrer`,children:t(`com_ui_terms_of_service`)', 2),
    'function Sb({index:e,disabled:t,agentId:n,', `${MCP_DIALOG}function Sb({index:e,disabled:t,agentId:n,`),
    ']}),j&&(0,$.jsx)(Rh,{...j,conversationId:s,storageContextKey:C?.storageContextKey})]})}var Cb=',
    ']}),(0,$.jsx)(bosMcpDialog,{manager:C?.mcpServerManager}),j&&(0,$.jsx)(Rh,{...j,conversationId:s,storageContextKey:C?.storageContextKey})]})}var Cb='),
    ',D&&!l&&(0,$.jsx)(Fh,{agent:D,className:`animate-fadeIn mt-2 max-w-md justify-center text-center text-sm`})]',
    ']'),
  'AnalyticsConsent.BAR8fz4n.js': (js) => swap(swap(js,
    'href:s,rel:`noreferrer`,children:o(`com_ui_privacy_policy`)',
    'href:s,target:`_blank`,rel:`noopener noreferrer`,children:o(`com_ui_privacy_policy`)'),
    'href:c,rel:`noreferrer`,children:o(`com_ui_terms_of_service`)',
    'href:c,target:`_blank`,rel:`noopener noreferrer`,children:o(`com_ui_terms_of_service`)'),
  'hosts.BXYGQJxl.js': (js) => swap(js,
    'onClick:be,children:v(`com_ui_sign_in_to_domain`,{0:ie})',
    'onClick:be,title:I&&L?ie:void 0,children:I&&L?`Anmeldung an ${L.charAt(0).toUpperCase()+L.slice(1)}`:v(`com_ui_sign_in_to_domain`,{0:ie})'),
  'markdown.jXG8lNzH.js': (js) => swap(js,
    '}\\`);\n}\n<\\/script>',
    '}\\`);\ndocument.getElementById(\'content\').querySelectorAll(\'a\').forEach(function(a){a.target=\'_blank\';a.rel=\'noopener noreferrer\'});\n}\n<\\/script>'),
  'ToolMermaidArtifact.D2tE9Aqa.js': (js) => swap(swap(js,
    'var yL=(0,q.memo)(function({src:e,alt:t,title:n,className:r,style:i}){',
    'function bosExternal(s){if(!s||/^(data|blob):/i.test(s))return!1;try{let u=new URL(s,location.href);return/^https?:$/.test(u.protocol)&&u.origin!==location.origin}catch{return!1}}'
      + 'var bosExtImg=(0,q.memo)(function({src:e,alt:t,title:n,className:r,style:i}){let[a,o]=(0,q.useState)(!1),h=new URL(e,location.href).host,v=' + VIDEO + '.test(e);'
      + 'if(a)return v?(0,J.jsx)(`video`,{src:e,controls:!0,preload:`metadata`,title:t||n,className:r,style:{maxWidth:`100%`,...i}}):(0,J.jsx)(`img`,{src:e,alt:t,title:n,className:r,style:i});'
      + 'return(0,J.jsx)(`button`,{type:`button`,title:e,onClick:c=>{c.preventDefault(),c.stopPropagation(),o(!0)},className:`my-1 inline-block max-w-full break-all rounded-lg border border-border-medium px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-surface-hover`,children:`${v?`Video`:`Bild`} von ${h} laden${t?` – ${t}`:``}`})});'
      + 'var yL=(0,q.memo)(function({src:e,alt:t,title:n,className:r,style:i}){'),
    'return(0,J.jsx)(`img`,{src:s,alt:t,title:n,className:r,style:i})});yL.displayName=`MarkdownImage`',
    'if(bosExternal(s))return(0,J.jsx)(bosExtImg,{src:s,alt:t,title:n,className:r,style:i});'
      + 'return' + VIDEO + '.test(s??``)?(0,J.jsx)(`video`,{src:s,controls:!0,preload:`metadata`,title:t||n,className:r,style:{maxWidth:`100%`,...i}}):(0,J.jsx)(`img`,{src:s,alt:t,title:n,className:r,style:i})});yL.displayName=`MarkdownImage`'),
};

let sw = fs.readFileSync(`${dist}/sw.js`, 'utf8');
for (const [name, patch] of Object.entries(chunks)) {
  write(name, patch(fs.readFileSync(`${dist}/assets/${name}`, 'utf8')));
  sw = swap(sw, `${name}",revision:null`, `${name}",revision:"${REVISION}"`);
}
write('sw.js', sw, false);
console.log('ok');
