// The identity is drawn as vectors. No network, fonts or model generation required.
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root=new URL('../',import.meta.url),asset=new URL('assets/',root);
const psi='M72 8H88V106C112 102 126 88 126 66V32L144 14V66C144 99 122 122 88 126V172H72V126C38 122 16 99 16 66V14L34 32V66C34 88 48 102 72 106V8Z';
const letters='M0 108V0H52L72 20V52L52 72H20V108H0ZM20 20V52H44L52 44V28L44 20H20Z M184 0H124L104 20V45L124 65H164V88H104V108H164L184 88V65L164 45H124V20H184V0Z M216 0H264V18H249V90H264V108H216V90H231V18H216V0Z';
const mark=`<defs><path id="psi" d="${psi}"/></defs><use href="#psi" transform="translate(9 9)" fill="#174f3b"/><use href="#psi" transform="translate(5 5)" fill="#388663"/><use href="#psi" fill="#93e4b6" stroke="#c6f5d8" stroke-width="1"/>`;
await mkdir(asset,{recursive:true});
await writeFile(new URL('psi.svg',asset),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 192" role="img" aria-labelledby="t"><title id="t">Psi, a cut-tip Greek psi</title><g transform="translate(5 4)">${mark}</g></svg>\n`);
await writeFile(new URL('psi-wordmark.svg',asset),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 510 192" role="img" aria-labelledby="t"><title id="t">Psi</title><g transform="translate(5 4)">${mark}</g><path d="${letters}" transform="translate(220 42)" fill="#93e4b6" fill-rule="evenodd"/></svg>\n`);
const contours=Array.from({length:7},(_,i)=>`<ellipse cx="1010" cy="330" rx="${130+i*25}" ry="${210+i*13}" transform="rotate(-24 1010 330)"/>`).join('');
const ticks=Array.from({length:25},(_,i)=>`<path d="M${72+i*20} 550v${i%5?4:9}"/>`).join('');
const hero=`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-labelledby="t d">
<title id="t">Psi. Long loops. Small footprint.</title><desc id="d">A sculpted mint psi beside the geometric PSI wordmark, with orbital lines showing a continuous loop.</desc>
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0b201a"/><stop offset="1" stop-color="#17382b"/></linearGradient><path id="psi" d="${psi}"/></defs>
<rect width="1280" height="640" fill="url(#bg)"/>
<g stroke="#68b88f" stroke-width="1" fill="none" opacity=".2">${contours}</g>
<path d="M704 0v640" stroke="#6caf8a" stroke-opacity=".14"/>
<g fill="#8bbe9e" font-family="Menlo,Consolas,monospace" font-size="12" letter-spacing="2"><text x="72" y="72">LOCAL / MULTI-MODEL / LONG RUNS</text><text x="72" y="590" font-size="11">PLAN → EXECUTE → MEASURE → REPEAT</text></g>
<path d="${letters}" transform="translate(72 160) scale(1.95)" fill="#d9efdf" fill-rule="evenodd"/>
<g fill="#a7cfb5" font-family="Menlo,Consolas,monospace" font-size="26" letter-spacing="-.8"><text x="72" y="445">Long loops.</text><text x="72" y="483">Small footprint.</text></g>
<g stroke="#89b99b" stroke-opacity=".45">${ticks}</g>
<g transform="translate(790 92) scale(2.65)"><use href="#psi" transform="translate(13 10)" fill="#103e2b"/><use href="#psi" transform="translate(9 7)" fill="#246b49"/><use href="#psi" transform="translate(4 3)" fill="#52a475"/><use href="#psi" fill="#a1efbd" stroke="#dbf8d8" stroke-width=".6"/></g>
<g fill="#78b890"><circle cx="1122" cy="100" r="3"/><circle cx="761" cy="505" r="3"/></g>
</svg>`;
await writeFile(new URL('hero.svg',asset),hero+'\n');
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.PSI_CHROME_PATH||'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:640},deviceScaleFactor:1});
 await page.setContent(`<html><style>*{margin:0}svg{display:block}</style>${hero}</html>`);await page.screenshot({path:fileURLToPath(new URL('hero.png',asset))});
 const logo=await readFile(new URL('psi.svg',asset),'utf8');
 await page.setViewportSize({width:512,height:512});await page.setContent(`<html><style>*{margin:0}body{background:#102b21;display:grid;place-items:center;width:512px;height:512px}svg{height:390px}</style>${logo}</html>`);await page.screenshot({path:fileURLToPath(new URL('social-logo.png',asset))});
 console.log('Rendered vector identity, README hero and standalone logo image.');
}finally{await browser?.close();}
