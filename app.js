'use strict';
/* Painel de evidências ABEP-TIC.
   Textos dos indicadores: dados/AAAA.js (gerado do PDF). Aqui só tela e gravação.
   Gravação: pelo servidor.py, que lê e grava na pasta da rede (caminho fixo nele). Dentro dela:
     <ano>/Dimensao <id>/<codigo>/resposta.json   ← marcações, links, observação, quem salvou cada item
     <ano>/Dimensao <id>/<codigo>/<qualif> - arquivo.ext
     <ano>/log-evidencias.csv                     ← log só de acréscimo: quem anexou/removeu arquivo ou link
   A lista de anexos é lida da própria pasta (fonte única): arquivo posto à mão pelo Explorer também aparece.
   "Item" = o próprio indicador (checkbox/opção, links, observação) ou um qualificador (1.1a...). Cada item tem seu
   botão Salvar e só vai para o disco quando ele é clicado; até lá fica em est.rascunho. */

const $ = (s) => document.querySelector(s);
const RESPOSTA = 'resposta.json';
const REGISTRO = 'log-evidencias.csv';
const HASH_INICIAL = '0'.repeat(64);
// Indicador cujo texto de evidência começa assim não exige anexo ("Não é necessário...", "A UF não deverá enviar...")
const SEM_EVIDENCIA = /^(\*\*)?(A UF )?n[ãa]o (é necessário|deverá enviar|é exigido)/i;

const est = {
  ano: null,
  raiz: null,          // pasta das evidências (pastaServidor)
  respostas: {},       // codigo -> resposta como foi lida do disco
  arquivos: {},        // codigo -> [nomes] na pasta
  autores: {},         // "codigo/arquivo" -> { por, em } (última linha "anexou" do log)
  logProblema: '',     // mensagem se o log foi adulterado (fica no topo até recarregar)
  foto: null,          // { caminho no ano: data } da última leitura da pasta (vigia)
  salvando: false,     // vigia espera enquanto um Salvar está gravando
  rascunho: {},        // codigo -> item -> { dados, novos: [{ nome, file }], remover: Set<nome> }
  dim: 0,
  tela: 'indicadores', // ou 'evidencias' (tela "Evidências enviadas")
  autoresLink: {},     // "codigo|qualificador|url" -> { por, em } (linha "adicionou link" do log)
};

/* ---------- utilidades ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const dados = () => window.IOSPD[est.ano];
const todos = () => dados().dimensoes.flatMap((d) => d.indicadores.map((i) => ({ dim: d, ind: i })));
const achar = (cod) => todos().find((x) => x.ind.codigo === cod);
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const ehMultipla = (ind) => /múltipla/i.test(ind.tipo);
const semEvidencia = (ind) => SEM_EVIDENCIA.test(ind.evidencias.trim());
const novaResposta = () => ({ atende: false, opcao: '', qualificadores: {}, links: [], obs: '' });
const salvo = (cod) => est.respostas[cod] || novaResposta();
const temRascunho = (cod) => Object.keys(est.rascunho[cod] || {}).length > 0;
const algumRascunho = () => Object.keys(est.rascunho).some(temRascunho);

/** Dados de um item, sempre com as mesmas chaves e ordem (a comparação de conflito usa JSON). */
function itemDe(r, cod, item) {
  if (item === cod) return { atende: !!r.atende, opcao: r.opcao || '', links: r.links || [], obs: r.obs || '', salvoPor: r.salvoPor || '', salvoEm: r.salvoEm || '' };
  const q = r.qualificadores?.[item] || {};
  return { atende: !!q.atende, links: q.links || [], salvoPor: q.salvoPor || '', salvoEm: q.salvoEm || '' };
}
function aplicarItem(r, cod, item, d) {
  if (item === cod) Object.assign(r, d);
  else (r.qualificadores ||= {})[item] = d;
}
/** O que a tela mostra: o salvo com os rascunhos por cima. */
function visto(cod) {
  const r = structuredClone(salvo(cod));
  for (const [item, d] of Object.entries(est.rascunho[cod] || {})) aplicarItem(r, cod, item, d.dados);
  return r;
}

/** Texto do PDF (**negrito**, "• " lista, "◦ " sublista) → HTML. */
function md(t) {
  if (!t) return '';
  let h = '', lista = null;
  for (const l of t.split('\n')) {
    const sub = l.startsWith('◦ '), item = sub || l.startsWith('• ');
    if (item) {
      const cls = sub ? 'sub' : '';
      if (lista !== cls) { if (lista !== null) h += '</ul>'; h += `<ul class="${cls}">`; lista = cls; }
      h += `<li>${inline(l.slice(2))}</li>`;
    } else {
      if (lista !== null) { h += '</ul>'; lista = null; }
      h += `<p>${inline(l)}</p>`;
    }
  }
  return lista !== null ? h + '</ul>' : h;
}

function aviso(msg, erro = false, acao = null) {
  // alerta de log adulterado não some ao limpar outros avisos
  if (!msg && est.logProblema) { msg = est.logProblema; erro = true; }
  const a = $('#aviso');
  a.hidden = !msg;
  a.className = 'aviso' + (erro ? ' erro' : '');
  a.innerHTML = esc(msg);
  if (acao) {
    const b = document.createElement('button');
    b.className = 'sec'; b.textContent = acao.texto; b.onclick = acao.fn;
    a.append(b);
  }
}

/* ---------- pasta das evidências via servidor.py ----------
   Mesma forma dos "handles" de pasta/arquivo do navegador (getDirectoryHandle, getFileHandle, entries, getFile,
   createWritable, removeEntry), para o resto do código não depender de onde os arquivos estão. */
const api = (rota, p) => `/api/${rota}?p=${encodeURIComponent(p)}`;
async function ok(r) {
  if (r.status === 404) throw Object.assign(new Error('não existe'), { name: 'NotFoundError' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || r.statusText);
  return r;
}

function arquivoServidor(p, nome, criar) {
  return {
    kind: 'file', name: nome,
    async getFile() {
      const r = await fetch(api('arquivo', p));
      if (r.status === 404 && criar) return new Blob([]);
      const b = await (await ok(r)).blob();
      b.lastModified = +r.headers.get('X-Modificado');
      return b;
    },
    // grava o arquivo inteiro de uma vez no close (o log não passa por aqui: ver registrar)
    async createWritable() {
      const partes = [];
      return {
        write(x) { partes.push(x); },
        async close() { await ok(await fetch(api('arquivo', p), { method: 'PUT', body: new Blob(partes) })); },
      };
    },
  };
}

function pastaServidor(rel, nome) {
  const junta = (n) => (rel ? `${rel}/` : '') + n;
  return {
    kind: 'directory', name: nome,
    async getDirectoryHandle(n, o = {}) {
      await ok(await fetch(api(o.create ? 'pasta' : 'lista', junta(n)), { method: o.create ? 'POST' : 'GET' }));
      return pastaServidor(junta(n), n);
    },
    async getFileHandle(n, o = {}) { return arquivoServidor(junta(n), n, !!o.create); },
    async *entries() {
      for (const e of await (await ok(await fetch(api('lista', rel)))).json()) {
        yield [e.nome, e.tipo === 'directory' ? pastaServidor(junta(e.nome), e.nome) : arquivoServidor(junta(e.nome), e.nome)];
      }
    },
    async removeEntry(n) { await ok(await fetch(api('arquivo', junta(n)), { method: 'DELETE' })); },
  };
}

/* ---------- usuário ---------- */
function usuario() {
  try { return localStorage.getItem('abep.usuario') || ''; } catch { return ''; }
}
function pedirUsuario() {
  const n = (prompt('Seu nome (fica registrado em cada alteração):', usuario()) || '').trim();
  if (n) try { localStorage.setItem('abep.usuario', n); } catch { /* sem storage: pede de novo depois */ }
  $('#btn-usuario').textContent = n ? `Usuário: ${n}` : 'Informar nome';
  return n;
}

/* ---------- log-evidencias.csv ---------- */
const csvCampo = (v) => (/[;"\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function csvLinha(l) {
  const campos = [], re = /("(?:[^"]|"")*"|[^;]*)(;|$)/y;
  for (let m; re.lastIndex <= l.length && (m = re.exec(l));) {
    campos.push(m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]);
    if (!m[2]) break; // fim da linha
  }
  return campos;
}

/* Log de evidências (log-evidencias.csv): cada linha leva o hash SHA-256 da linha anterior + os próprios campos.
   Editar, apagar ou reordenar qualquer linha quebra a corrente, e a página avisa ao abrir. Apagar linhas do fim é
   pego pela "âncora": cada navegador guarda o tamanho e o último hash que já viu.
   O mesmo cálculo está em ferramentas/importar_evidencias.py (hash_linha). */
async function hashLinha(anterior, campos) {
  const bytes = new TextEncoder().encode([anterior, ...campos].join('\x1f'));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function lerLog(anoDir) {
  try {
    const txt = await (await (await anoDir.getFileHandle(REGISTRO)).getFile()).text();
    return txt.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean).map(csvLinha);
  } catch (e) { if (e.name === 'NotFoundError') return []; throw e; }
}

/** Confere a corrente inteira. Devolve a mensagem do primeiro problema ou ''. */
async function conferirLog(linhas) {
  let anterior = HASH_INICIAL;
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (l.length !== 8 || l[6] !== anterior || l[7] !== await hashLinha(anterior, l.slice(0, 6))) {
      return `a linha ${i + 2} foi alterada, apagada ou inserida fora do painel`;
    }
    anterior = l[7];
  }
  return '';
}

const chaveAncora = () => `abep.log.${est.raiz.name}.${est.ano}`;

async function lerRegistro() {
  est.autores = {};
  let anoDir;
  try { anoDir = await est.raiz.getDirectoryHandle(String(est.ano)); } catch { return; }
  const linhas = await lerLog(anoDir);
  let problema = await conferirLog(linhas);
  let ancora = null;
  try { ancora = JSON.parse(localStorage.getItem(chaveAncora()) || 'null'); } catch { /* sem storage */ }
  if (!problema && ancora && (linhas.length < ancora.n || (ancora.n > 0 && linhas[ancora.n - 1]?.[7] !== ancora.hash))) {
    problema = `o log tinha ${ancora.n} registros da última vez que esta página abriu e agora tem ${linhas.length}`;
  }
  est.logProblema = problema ? `Atenção: ${REGISTRO} foi modificado fora do painel (${problema}). Avise a coordenação.` : '';
  if (problema) aviso(est.logProblema, true);
  else try { localStorage.setItem(chaveAncora(), JSON.stringify({ n: linhas.length, hash: linhas.at(-1)?.[7] || HASH_INICIAL })); } catch { /* ok */ }
  est.autoresLink = {};
  for (const [em, por, acao, cod, qual, evidencia] of linhas) {
    if (acao === 'anexou') est.autores[`${cod}/${evidencia}`] = { por, em };
    if (acao === 'adicionou link') est.autoresLink[`${cod}|${qual}|${evidencia}`] = { por, em };
  }
}

/** Acrescenta registros ao fim do log, encadeados. Nunca reescreve linhas antigas.
    O servidor.py só aceita se o hash de onde a corrente parte ainda for o da última linha do log (trava entre
    pessoas); se outra pessoa gravou antes, responde 409 e aqui o encadeamento é refeito em cima do log atualizado. */
async function registrar(registros) {
  if (!registros.length) return;
  const anoDir = await est.raiz.getDirectoryHandle(String(est.ano), { create: true });
  for (let tentativa = 0; tentativa < 8; tentativa++) {
    const atuais = await lerLog(anoDir);
    const inicio = atuais.at(-1)?.[7] || HASH_INICIAL;
    let anterior = inicio, texto = '';
    for (const campos of registros) {
      const hash = await hashLinha(anterior, campos);
      texto += [...campos, anterior, hash].map(csvCampo).join(';') + '\r\n';
      anterior = hash;
    }
    const r = await fetch(api('acrescentar', `${est.ano}/${REGISTRO}`), {
      method: 'POST', headers: { 'X-Hash-Anterior': inicio }, body: texto,
    });
    if (r.status === 409 || r.status === 503) { // outra pessoa gravou ou está gravando: espera um pouco e refaz
      await new Promise((ok) => setTimeout(ok, 100 + Math.random() * 400));
      continue;
    }
    await ok(r);
    try { localStorage.setItem(chaveAncora(), JSON.stringify({ n: atuais.length + registros.length, hash: anterior })); } catch { /* ok */ }
    return;
  }
  throw new Error(`não consegui gravar no ${REGISTRO} (muita gente salvando ao mesmo tempo)`);
}

/* ---------- arquivos em disco ---------- */
async function pastaDo(cod, criar) {
  const { dim } = achar(cod);
  let d = await est.raiz.getDirectoryHandle(String(est.ano), { create: criar });
  d = await d.getDirectoryHandle(`Dimensao ${dim.id}`, { create: criar });
  return d.getDirectoryHandle(cod, { create: criar });
}

async function lerResposta(pasta) {
  try { return Object.assign(novaResposta(), JSON.parse(await (await (await pasta.getFileHandle(RESPOSTA)).getFile()).text())); }
  catch (e) { if (e.name === 'NotFoundError') return novaResposta(); throw e; }
}

async function lerIndicador(cod) {
  est.arquivos[cod] = [];
  delete est.respostas[cod];
  let pasta;
  try { pasta = await pastaDo(cod, false); } catch { return; } // ainda não existe
  for await (const [nome, h] of pasta.entries()) {
    if (h.kind !== 'file') continue;
    if (nome === RESPOSTA) {
      try { est.respostas[cod] = await lerResposta(pasta); }
      catch { aviso(`${cod}/${RESPOSTA} está corrompido. Corrija ou apague o arquivo.`, true); }
    } else if (!nome.endsWith('.crswap')) {
      est.arquivos[cod].push(nome);
    }
  }
  est.arquivos[cod].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
}

/** Lê tudo da pasta. Rascunhos não salvos continuam na tela. */
async function carregarTudo() {
  est.respostas = {}; est.arquivos = {};
  if (est.raiz) await Promise.all([lerRegistro(), ...todos().map((x) => lerIndicador(x.ind.codigo))]);
  est.foto = await fotoDaPasta();
  render();
}

/* ---------- vigia da pasta ----------
   A cada "intervalo_segundos" (config.json) pergunta ao servidor.py a lista de arquivos do ano com a data de cada um.
   Se algo entrou, saiu ou mudou (outra pessoa salvou ou mexeu pelo Windows), relê a pasta e avisa, como o botão
   Atualizar. As próprias alterações não geram aviso: depois de salvar, a "foto" é refeita. */
async function fotoDaPasta() {
  try { return await (await ok(await fetch(api('estado', String(est.ano))))).json(); } catch { return null; }
}

function descreverMudanca(antes, depois) {
  const nome = (p) => p.split('/').pop();
  const ehEvid = (p) => !/(^|\/)(resposta\.json|log-evidencias\.csv)$/.test(p);
  const novos = Object.keys(depois).filter((p) => !(p in antes));
  const removidos = Object.keys(antes).filter((p) => !(p in depois));
  const alterados = Object.keys(depois).filter((p) => p in antes && antes[p] !== depois[p]);
  if (!novos.length && !removidos.length && !alterados.length) return '';
  const lista = (ps) => ps.slice(0, 3).map(nome).join(', ') + (ps.length > 3 ? ` e mais ${ps.length - 3}` : '');
  const partes = [];
  if (novos.some(ehEvid)) partes.push(`entrou: ${lista(novos.filter(ehEvid))}`);
  if (removidos.some(ehEvid)) partes.push(`saiu: ${lista(removidos.filter(ehEvid))}`);
  const salvos = [...new Set([...novos, ...alterados].filter((p) => p.endsWith('/resposta.json')).map((p) => p.split('/').at(-2)))];
  if (salvos.length) partes.push(`indicadores salvos por outra pessoa: ${salvos.join(', ')}`);
  return partes.length ? `Pasta atualizada às ${new Date().toLocaleTimeString('pt-BR', { timeStyle: 'short' })} — ${partes.join('; ')}.` : 'Pasta atualizada.';
}

/** Depois de salvar: a foto passa a conter o que eu gravei (pasta do indicador e log), mas o resto continua com a
    foto antiga, para mudanças de outras pessoas ainda serem avisadas. */
async function absorverMinhaMudanca(cod) {
  const nova = await fotoDaPasta();
  if (!nova || !est.foto) return;
  const meu = (p) => p.startsWith(`Dimensao ${achar(cod).dim.id}/${cod}/`) || p === REGISTRO;
  for (const p of Object.keys(est.foto)) if (meu(p) && !(p in nova)) delete est.foto[p];
  for (const [p, v] of Object.entries(nova)) if (meu(p)) est.foto[p] = v;
}

function vigiar(segundos) {
  setInterval(async () => {
    if (!est.raiz || est.salvando || !est.foto) return;
    // pessoa digitando: espera a próxima rodada para não tirar o cursor do campo
    if (document.activeElement?.closest?.('main') && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
    const nova = await fotoDaPasta();
    if (!nova) return;
    const msg = descreverMudanca(est.foto, nova);
    if (!msg) return;
    await carregarTudo();
    aviso(msg);
  }, segundos * 1000);
}

async function gravarArquivo(dir, nome, conteudo) {
  const w = await (await dir.getFileHandle(nome, { create: true })).createWritable();
  await w.write(conteudo);
  await w.close();
}

function descartar(cod, item) {
  delete est.rascunho[cod]?.[item];
  if (!temRascunho(cod)) delete est.rascunho[cod];
}

/** Botão Salvar de um item: relê o resposta.json, confere conflito só daquele item, grava anexos, remove os marcados
    (o servidor.py move para <ano>/_backup e nunca apaga; também guarda lá a versão antiga de um anexo substituído),
    resposta.json (só o item muda; o resto vem do disco, com o que outras pessoas salvaram) e registro. */
async function salvarItem(cod, item) {
  const rasc = est.rascunho[cod]?.[item];
  if (!rasc || !est.raiz) return;
  const quem = usuario() || pedirUsuario();
  if (!quem) { aviso('Informe seu nome para salvar.', true); return; }
  est.salvando = true;
  try {
    const pasta = await pastaDo(cod, true);
    const disco = await lerResposta(pasta);
    const noDisco = itemDe(disco, cod, item);
    if (JSON.stringify(noDisco) !== JSON.stringify(itemDe(salvo(cod), cod, item))) {
      aviso(`Não salvei o ${item}: ${noDisco.salvoPor || 'outra pessoa'} alterou ${noDisco.salvoEm ? 'em ' + hora(noDisco.salvoEm) : 'antes'}. ` +
        'Descarte e refaça sua alteração.', true,
        { texto: `Descartar ${item} e recarregar`, fn: async () => { descartar(cod, item); await lerIndicador(cod); aviso(''); renderCard(cod); } });
      return;
    }
    const agora = new Date().toISOString();
    const linhas = [];
    const quals = (nome) => codigosDoArquivo(cod, nome).filter((c) => c !== cod).join(',');
    for (const { nome, file } of rasc.novos) {
      await gravarArquivo(pasta, nome, file);
      linhas.push([agora, quem, 'anexou', cod, quals(nome), nome]);
    }
    for (const nome of rasc.remover) {
      await pasta.removeEntry(nome); // o servidor move para _backup
      linhas.push([agora, quem, 'removeu', cod, quals(nome), nome]);
    }
    const qual = item === cod ? '' : item;
    for (const l of rasc.dados.links) if (!noDisco.links.includes(l)) linhas.push([agora, quem, 'adicionou link', cod, qual, l]);
    for (const l of noDisco.links) if (!rasc.dados.links.includes(l)) linhas.push([agora, quem, 'removeu link', cod, qual, l]);
    aplicarItem(disco, cod, item, { ...rasc.dados, salvoPor: quem, salvoEm: agora });
    Object.assign(disco, { indicador: cod, ano: est.ano, editadoPor: quem, editadoEm: agora });
    await gravarArquivo(pasta, RESPOSTA, JSON.stringify(disco, null, 2));
    await registrar(linhas);
    for (const l of linhas) if (l[2] === 'anexou') est.autores[`${cod}/${l[5]}`] = { por: quem, em: agora };
    descartar(cod, item);
    await lerIndicador(cod);
    await absorverMinhaMudanca(cod);
    aviso('');
  } catch (e) {
    console.error(e);
    aviso(`Erro ao salvar ${item}: ${e.message}. A alteração continua na tela; tente de novo.`, true);
  } finally {
    est.salvando = false;
  }
  renderCard(cod);
}

/** Toda mudança na tela passa por aqui: altera só o rascunho do item.
    redesenhar=false para digitação: refazer o card tiraria o foco do campo. */
function editar(cod, item, fn, redesenhar = true) {
  const rasc = ((est.rascunho[cod] ||= {})[item] ||=
    { dados: structuredClone(itemDe(salvo(cod), cod, item)), novos: [], remover: new Set() });
  fn(rasc.dados, rasc);
  if (redesenhar) return renderCard(cod);
  const el = document.querySelector(`.ind[data-cod="${cod}"]`);
  el.querySelector('.selos').innerHTML = selos(achar(cod).ind);
  document.getElementById(`aba-${cod}`).outerHTML = abaHtml(achar(cod).ind);
  el.querySelector(`[data-item="${item}"] > .rodape-item`).outerHTML = rodapeItem(cod, item);
  renderMenu();
}

function anexarNoRascunho(cod, item, arquivos) {
  editar(cod, item, (d, rasc) => {
    for (const f of arquivos) {
      const nome = f.name.startsWith(item + ' ') ? f.name : `${item} - ${f.name}`;
      const jaNaPasta = (est.arquivos[cod] || []).includes(nome);
      if (jaNaPasta && !confirm(`Já existe "${nome}". Substituir ao salvar?`)) continue;
      rasc.novos = rasc.novos.filter((n) => n.nome !== nome);
      rasc.novos.push({ nome, file: f });
    }
  });
}

/* ---------- situação de cada indicador ---------- */
/** "1.1b-c - X.pdf" vale para 1.1b e 1.1c; "1.1 - X.pdf" (ou sem código) vale para o indicador 1.1. */
function codigosDoArquivo(cod, nome) {
  const m = nome.match(/^(\d\.\d{1,2})([a-h](?:-[a-h])*)? - /);
  if (!m || m[1] !== cod || !m[2]) return [cod];
  return m[2].split('-').map((l) => cod + l);
}
/** Anexos que valem para o prefixo. Com rascunho: marca o que vai ser removido e entra o que vai ser enviado. */
function anexosDe(cod, prefixo, comRascunho = false) {
  const rascs = comRascunho ? Object.values(est.rascunho[cod] || {}) : [];
  const remover = new Set(rascs.flatMap((r) => [...r.remover]));
  const novos = rascs.flatMap((r) => r.novos.map((n) => ({ nome: n.nome, estado: 'novo' })));
  const naPasta = (est.arquivos[cod] || []).map((nome) => ({ nome, estado: remover.has(nome) ? 'remover' : '' }));
  return [...naPasta.filter((a) => !novos.some((n) => n.nome === a.nome)), ...novos]
    .filter((a) => codigosDoArquivo(cod, a.nome).includes(prefixo));
}
const temEvid = (cod, prefixo, links) => anexosDe(cod, prefixo).length > 0 || (links || []).some((l) => l.trim());

/** Conta os itens do indicador. Usa o que está salvo. Itens: cada qualificador, a opção (1.11) e, no indicador
    sem qualificador e sem opção, a própria evidência (conta quando há anexo ou link). */
function situacao(ind) {
  const cod = ind.codigo, r = salvo(cod);
  const quals = ind.qualificadores.filter((q) => r.qualificadores[q.codigo]?.atende);
  const faltam = [];
  if (!ind.qualificadores.length && !ind.opcoes.length && semEvidencia(ind)) {
    return { cls: 'isento', txt: 'Não exige evidência', faltam }; // fora de "Preenchidos": tem cartão próprio
  }
  const itemInd = ind.opcoes.length ? !!r.opcao
    : !ind.qualificadores.length ? temEvid(cod, cod, r.links) : null; // null = sem item próprio
  const total = ind.qualificadores.length + (itemInd === null ? 0 : 1);
  const feitos = quals.length + (itemInd ? 1 : 0);
  if (ind.opcoes.length && r.opcao && !semEvidencia(ind) && !temEvid(cod, cod, r.links)) faltam.push(cod);
  // qualificador só exige anexo próprio quando o PDF lista evidência para ele
  for (const q of quals) if (q.evidencias && !temEvid(cod, q.codigo, r.qualificadores[q.codigo].links)) faltam.push(q.codigo);
  const base = !feitos ? { cls: '', txt: 'Pendente' }
    : feitos < total ? { cls: 'parcial', txt: `Parcialmente preenchido ${feitos}/${total}` }
      : { cls: 'ok', txt: 'Preenchido' };
  return { ...base, faltam };
}

function selos(ind) {
  const s = situacao(ind);
  return `<span class="selo ${s.cls}">${esc(s.txt)}</span>` +
    (s.faltam.length ? `<span class="selo falta">Falta evidência: ${esc(s.faltam.join(', '))}</span>` : '') +
    (temRascunho(ind.codigo) ? '<span class="selo rascunho">Não salvo</span>' : '');
}

/* ---------- tela ---------- */
function render() {
  renderMenu();
  renderLista();
  if (est.tela === 'evidencias') renderEvidencias();
}

/* ---------- tela "Evidências enviadas" ---------- */
/** Todos os arquivos (lidos das pastas) e links (dos resposta.json) do ano, com quem enviou e quando (do log). */
function listaEvidencias() {
  const itens = [];
  for (const { dim, ind } of todos()) {
    const cod = ind.codigo, r = salvo(cod);
    for (const nome of est.arquivos[cod] || []) {
      const a = est.autores[`${cod}/${nome}`] || {};
      itens.push({ dim, ind, qual: codigosDoArquivo(cod, nome).filter((c) => c !== cod).join(', '), tipo: 'arquivo',
        evidencia: nome, caminho: `${est.ano}/Dimensao ${dim.id}/${cod}/${nome}`, por: a.por || '', em: a.em || '' });
    }
    const links = [['', r.links, r], ...Object.entries(r.qualificadores || {}).map(([q, d]) => [q, d.links, d])];
    for (const [qual, urls, origem] of links) {
      for (const url of urls || []) {
        const a = est.autoresLink[`${cod}|${qual}|${url}`] || { por: origem.salvoPor || '', em: origem.salvoEm || '' };
        itens.push({ dim, ind, qual, tipo: 'link', evidencia: url, por: a.por, em: a.em });
      }
    }
  }
  return itens;
}

/** Monta os filtros (mantendo o que estava escolhido) e a tabela. */
function renderEvidencias() {
  const itens = listaEvidencias();
  const opcoes = (sel, lista, todasTxt) => {
    const atual = sel.value;
    sel.innerHTML = `<option value="">${todasTxt}</option>` + lista.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    sel.value = lista.some(([v]) => v === atual) ? atual : '';
  };
  opcoes($('#ev-dim'), dados().dimensoes.map((d) => [d.id, `Dimensão ${d.id}`]), 'Todas as dimensões');
  opcoes($('#ev-pessoa'), [...new Set(itens.map((i) => i.por).filter(Boolean))].sort().map((p) => [p, p]), 'Todas as pessoas');
  atualizarTabelaEv(itens);
}

function atualizarTabelaEv(itens = listaEvidencias()) {
  const termo = $('#ev-busca').value.trim().toLowerCase(), dim = $('#ev-dim').value, pessoa = $('#ev-pessoa').value;
  const vistos = itens.filter((i) => (!dim || i.dim.id === dim) && (!pessoa || i.por === pessoa) &&
    (!termo || `${i.ind.codigo} ${i.qual} ${i.evidencia} ${i.ind.pergunta}`.toLowerCase().includes(termo)));
  const arq = vistos.filter((i) => i.tipo === 'arquivo').length;
  $('#ev-contagem').textContent = `${vistos.length} evidências (${arq} arquivos, ${vistos.length - arq} links)`;
  $('#ev-linhas').innerHTML = vistos.map((i) => `<tr>
    <td><span class="cod">${i.ind.codigo}</span><small class="mudo">Dimensão ${esc(i.dim.id)}</small></td>
    <td>${esc(i.qual) || '<span class="mudo">indicador</span>'}</td>
    <td class="ev-nome">${i.tipo === 'arquivo'
      ? `<a href="${api('arquivo', i.caminho)}" download="${esc(i.evidencia)}">${esc(i.evidencia)}</a>`
      : `<a href="${esc(i.evidencia)}" target="_blank" rel="noopener noreferrer">${esc(i.evidencia)}</a>`}
      <small class="mudo">${i.tipo === 'arquivo' ? 'arquivo' : 'link'}</small></td>
    <td>${esc(i.por) || '<span class="mudo">sem registro</span>'}</td>
    <td>${i.em ? hora(i.em) : ''}</td>
    <td><button type="button" class="sec" data-abrir="${i.ind.codigo}">Abrir indicador</button></td></tr>`).join('')
    || '<tr><td colspan="6" class="mudo">Nenhuma evidência com esses filtros.</td></tr>';
}

function mostrarTela(tela) {
  est.tela = tela;
  $('#tela-indicadores').hidden = tela !== 'indicadores';
  $('#tela-evidencias').hidden = tela !== 'evidencias';
  $('#btn-evidencias').setAttribute('aria-current', String(tela === 'evidencias'));
  render();
}

/** Menu de dimensões (sidebar) + cartões de resumo do topo: os dois mostram o progresso salvo. */
function renderMenu() {
  $('#menu').innerHTML = dados().dimensoes.map((d, k) => {
    const n = d.indicadores.length;
    const cls = d.indicadores.map((i) => situacao(i).cls);
    const ok = cls.filter((c) => c === 'ok').length, parc = cls.filter((c) => c === 'parcial').length;
    return `<button type="button" data-dim="${k}" aria-current="${est.tela === 'indicadores' && k === est.dim && !$('#busca').value}">
      <span class="nome">Dimensão ${esc(d.id)}</span><span class="desc">${esc(d.nome)}</span>
      <span class="mudo">${ok} preenchidos · ${parc} parciais de ${n}</span>
      <span class="barra" aria-hidden="true"><i class="ok" style="width:${(100 * ok) / n}%"></i><i class="parcial" style="width:${(100 * parc) / n}%"></i></span></button>`;
  }).join('');

  const sits = todos().map(({ ind }) => situacao(ind));
  const conta = (f) => sits.filter(f).length;
  const cartao = (rotulo, valor, cor, sub) => `<div class="metrica" style="--cor:${cor}">
    <span class="bi-label">${rotulo}</span><span class="bi-metric">${valor}</span><small>${sub}</small></div>`;
  $('#resumo').innerHTML =
    cartao('Preenchidos', conta((s) => s.cls === 'ok'), 'var(--bi-success)', `de ${sits.length} indicadores`) +
    cartao('Parciais', conta((s) => s.cls === 'parcial'), 'var(--ds-color-info)', 'com parte dos itens marcada') +
    cartao('Pendentes', conta((s) => !s.cls), 'var(--bi-fg-subdued)', 'nada marcado ainda') +
    cartao('Falta evidência', conta((s) => s.faltam.length), 'var(--bi-warning)', 'item marcado sem anexo ou link') +
    cartao('Não exigem evidência', conta((s) => s.cls === 'isento'), 'var(--bi-fg-accent)', 'o Comitê avalia com dado público');
}

function menuCelular(abrir) {
  $('#sidebar').classList.toggle('aberta', abrir);
  $('#fundo-menu').hidden = !abrir;
  $('#btn-menu').setAttribute('aria-expanded', String(abrir));
  $('#btn-menu').hidden = abrir; // aberto, o ☰ ficaria por cima do logo; fecha clicando fora
}

function renderLista() {
  const termo = $('#busca').value.trim().toLowerCase();
  const pendentes = $('#so-pendentes').checked;
  let itens = termo ? todos() : dados().dimensoes[est.dim].indicadores.map((i) => ({ dim: dados().dimensoes[est.dim], ind: i }));
  if (termo) itens = itens.filter(({ ind }) => JSON.stringify(ind).toLowerCase().includes(termo));
  if (pendentes) itens = itens.filter(({ ind }) => !['ok', 'isento'].includes(situacao(ind).cls));
  const d = dados().dimensoes[est.dim];
  const cab = termo ? `<h2>Resultado da busca (${itens.length})</h2>` :
    `<h2>Dimensão ${esc(d.id)} – ${esc(d.nome)}</h2><span class="mudo">Valor de cada indicador: ${esc(d.valorIndicador)}</span>`;
  if (!itens.length) { $('#lista').innerHTML = `<div class="cab-dim">${cab}</div><p class="mudo">Nenhum indicador.</p>`; return; }
  // uma aba por indicador (padrão Tabs do bi-setdig); a aba aberta continua a mesma ao redesenhar
  if (!itens.some(({ ind }) => ind.codigo === est.aba)) est.aba = itens[0].ind.codigo;
  const ind = achar(est.aba).ind;
  $('#lista').innerHTML = `<div class="cab-dim">${cab}</div>
    <div role="tablist" aria-label="Indicadores" class="bi-tabs">${itens.map(({ ind: i }) => abaHtml(i)).join('')}</div>
    <section class="ind" role="tabpanel" id="painel-ind" aria-labelledby="aba-${ind.codigo}" data-cod="${ind.codigo}">
      <header class="ind-cab"><span class="cod">${ind.codigo}</span>
        <span class="perg">${esc(ind.pergunta)}<span class="tipo">${esc(ind.tipo)}</span></span>
        <span class="selos">${selos(ind)}</span></header>
      <div class="corpo">${corpo(ind)}</div></section>`;
}

function abaHtml(ind) {
  const sel = ind.codigo === est.aba;
  return `<button type="button" role="tab" class="bi-tab" id="aba-${ind.codigo}" data-aba="${ind.codigo}"
    aria-selected="${sel}" aria-controls="painel-ind" tabindex="${sel ? 0 : -1}" title="${esc(ind.pergunta)}">
    <span class="ponto ${situacao(ind).cls}${temRascunho(ind.codigo) ? ' rascunho' : ''}" aria-hidden="true"></span>${ind.codigo}</button>`;
}

function abrirAba(cod, focar = false) {
  if (cod === est.aba) return;
  est.aba = cod;
  renderLista();
  if (focar) document.getElementById(`aba-${cod}`)?.focus();
}

function blocoEvid(cod, item, links) {
  const dis = est.raiz ? '' : 'disabled';
  const lista = anexosDe(cod, item, true).map(({ nome, estado }) => {
    const autor = est.autores[`${cod}/${nome}`];
    const info = estado === 'novo' ? 'a enviar ao salvar' : estado === 'remover' ? 'será removido ao salvar'
      : autor ? `anexado por ${autor.por} em ${hora(autor.em)}` : '';
    const botao = estado === 'novo' ? 'Tirar' : estado === 'remover' ? 'Manter' : 'Remover';
    return `<li class="${estado}"><span><span class="nome-arq">${esc(nome)}</span>${info ? `<small>${esc(info)}</small>` : ''}</span>
      <button type="button" class="link" data-acao="remover" data-nome="${esc(nome)}" data-estado="${estado}" ${dis}>${botao}</button></li>`;
  }).join('');
  return `<div class="evid">
    <div class="soltar">Arraste arquivos aqui ou
      <button type="button" class="sec" data-acao="escolher" ${dis}>Anexar arquivo</button>
      <input type="file" multiple hidden data-acao="arquivo"></div>
    ${lista ? `<ul class="arquivos">${lista}</ul>` : ''}
    <label class="campo"><span>Links (um por linha)</span>
      <textarea data-campo="links" ${dis}>${esc((links || []).join('\n'))}</textarea></label></div>`;
}

/** Rodapé de cada item: quem salvou e, se houver alteração, Descartar/Salvar daquele item. */
function rodapeItem(cod, item) {
  const s = itemDe(salvo(cod), cod, item);
  const sujo = !!est.rascunho[cod]?.[item];
  return `<div class="rodape-item">
    <small class="mudo">${s.salvoPor ? `Salvo por ${esc(s.salvoPor)} em ${hora(s.salvoEm)}` : ''}</small>
    ${sujo ? `<button type="button" class="sec" data-acao="descartar">Descartar</button>
      <button type="button" data-acao="salvar">Salvar ${item === cod ? 'indicador' : item}</button>` : ''}</div>`;
}

function corpo(ind) {
  const cod = ind.codigo, r = visto(cod), dis = est.raiz ? '' : 'disabled';
  let h = ind.enunciado && !ind.opcoes.length ? `<div class="texto-pdf">${md(ind.enunciado)}</div>` : '';
  // texto longo do PDF pode ser recolhido para chegar mais rápido às marcações
  if (ind.evidencias) h += `<details class="texto-pdf" open><summary><h4>Tipos de evidências aceitas</h4></summary>${md(ind.evidencias)}</details>`;
  if (!est.raiz) h += '<p class="alerta">Abra o painel pelo abrir-painel.bat para marcar e anexar.</p>';

  // item do próprio indicador: opção (quando o PDF traz), anexos, links e observação. Sem checkbox próprio.
  const ctrl = ind.opcoes.length
    ? `<fieldset class="opcoes"><legend class="marca">${esc(ind.enunciado.replace(/:$/, '') || 'Resposta do Estado')}</legend>` + ind.opcoes.map((o) =>
      `<label><input type="radio" name="op-${cod}" value="${o.codigo}" data-campo="opcao" ${r.opcao === o.codigo ? 'checked' : ''} ${dis}>
       <span><strong>${o.codigo})</strong> ${esc(o.texto)}</span></label>`).join('') + '</fieldset>'
    : `<h4 class="titulo-item">Evidências do indicador ${cod}</h4>`;
  const blocoInd = `<div class="qual item-ind" data-item="${cod}">${ctrl}
    ${blocoEvid(cod, cod, r.links)}
    <label class="campo"><span>Observação interna</span><textarea data-campo="obs" ${dis}>${esc(r.obs)}</textarea></label>
    ${rodapeItem(cod, cod)}</div>`;
  // múltipla escolha: a evidência é por qualificador, então o bloco do indicador vai para o fim
  const indNoFim = ehMultipla(ind);
  if (!indNoFim) h += blocoInd;

  for (const q of ind.qualificadores) {
    const qr = r.qualificadores[q.codigo] || {};
    h += `<div class="qual ${qr.atende ? 'marcado' : ''}" data-item="${q.codigo}">
      <label class="marca"><input type="checkbox" data-campo="atende" ${qr.atende ? 'checked' : ''} ${dis}>
        <span>${q.codigo}. ${esc(q.texto)}</span></label>
      ${q.evidencias ? `<details><summary>Evidências aceitas para ${q.codigo}</summary><div class="texto-pdf">${md(q.evidencias)}</div></details>` : ''}
      ${qr.atende ? blocoEvid(cod, q.codigo, qr.links) : ''}
      ${rodapeItem(cod, q.codigo)}</div>`;
  }
  if (indNoFim) h += blocoInd;
  return h;
}

function renderCard(cod) {
  const { ind } = achar(cod);
  const aba = document.getElementById(`aba-${cod}`);
  if (aba) aba.outerHTML = abaHtml(ind);
  const el = document.querySelector(`.ind[data-cod="${cod}"]`);
  if (el) {
    el.querySelector('.selos').innerHTML = selos(ind);
    // preserva o texto do PDF recolhido
    const recolhido = el.querySelector('.corpo > details.texto-pdf:not([open])');
    el.querySelector('.corpo').innerHTML = corpo(ind);
    if (recolhido) el.querySelector('.corpo > details.texto-pdf')?.removeAttribute('open');
  }
  renderMenu();
}

/* ---------- eventos ---------- */
function alvo(t) {
  const card = t.closest('.ind[data-cod]'), bloco = t.closest('[data-item]');
  return card && bloco ? { cod: card.dataset.cod, item: bloco.dataset.item } : null;
}

function ligar() {
  const lista = $('#lista');
  // abas: clique e setas/Home/End (mesmo comportamento do Tabs.tsx do bi-setdig)
  lista.addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (b) abrirAba(b.dataset.aba);
  });
  lista.addEventListener('keydown', (e) => {
    const b = e.target.closest?.('[data-aba]');
    if (!b) return;
    const abas = [...lista.querySelectorAll('[data-aba]')];
    const i = abas.indexOf(b);
    const alvoIdx = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: abas.length - 1 }[e.key];
    if (alvoIdx === undefined) return;
    e.preventDefault();
    abrirAba(abas[(alvoIdx + abas.length) % abas.length].dataset.aba, true);
  });

  lista.addEventListener('change', (e) => {
    const t = e.target, a = alvo(t);
    if (!a) return;
    if (t.dataset.acao === 'arquivo') return anexarNoRascunho(a.cod, a.item, t.files);
    if (t.dataset.campo === 'atende') editar(a.cod, a.item, (d) => { d.atende = t.checked; });
    if (t.dataset.campo === 'opcao') editar(a.cod, a.item, (d) => { d.opcao = t.value; });
  });

  lista.addEventListener('input', (e) => {
    const t = e.target, a = alvo(t);
    if (!a || t.tagName !== 'TEXTAREA') return;
    editar(a.cod, a.item, (d) => {
      if (t.dataset.campo === 'obs') d.obs = t.value;
      else d.links = t.value.split('\n').map((l) => l.trim()).filter(Boolean);
    }, false);
  });

  lista.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-acao]'), a = b && alvo(b);
    if (!a) return;
    const acao = b.dataset.acao;
    if (acao === 'escolher') b.parentElement.querySelector('input[type=file]').click();
    if (acao === 'salvar') salvarItem(a.cod, a.item);
    if (acao === 'descartar') { descartar(a.cod, a.item); renderCard(a.cod); }
    if (acao === 'remover') {
      const { nome, estado } = b.dataset;
      editar(a.cod, a.item, (d, rasc) => {
        if (estado === 'novo') { for (const r of Object.values(est.rascunho[a.cod])) r.novos = r.novos.filter((n) => n.nome !== nome); }
        else if (estado === 'remover') { for (const r of Object.values(est.rascunho[a.cod])) r.remover.delete(nome); }
        else rasc.remover.add(nome);
      });
    }
  });

  for (const ev of ['dragover', 'dragleave', 'drop']) {
    lista.addEventListener(ev, (e) => {
      const z = e.target.closest?.('.soltar');
      if (!z || !est.raiz) return;
      e.preventDefault();
      z.classList.toggle('sobre', ev === 'dragover');
      const a = alvo(z);
      if (ev === 'drop' && a && e.dataTransfer.files.length) anexarNoRascunho(a.cod, a.item, e.dataTransfer.files);
    });
  }

  $('#menu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dim]');
    if (!b) return;
    est.dim = +b.dataset.dim;
    $('#busca').value = '';
    mostrarTela('indicadores');
    menuCelular(false);
    window.scrollTo(0, 0);
  });
  $('#btn-evidencias').addEventListener('click', () => { mostrarTela('evidencias'); menuCelular(false); window.scrollTo(0, 0); });
  $('#ev-busca').addEventListener('input', () => atualizarTabelaEv());
  $('#ev-dim').addEventListener('change', () => atualizarTabelaEv());
  $('#ev-pessoa').addEventListener('change', () => atualizarTabelaEv());
  $('#ev-linhas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-abrir]');
    if (!b) return;
    const { dim } = achar(b.dataset.abrir);
    est.dim = dados().dimensoes.indexOf(dim);
    est.aba = b.dataset.abrir;
    $('#busca').value = '';
    mostrarTela('indicadores');
    window.scrollTo(0, 0);
  });
  $('#btn-menu').addEventListener('click', () => menuCelular(true));
  $('#fundo-menu').addEventListener('click', () => menuCelular(false));
  $('#busca').addEventListener('input', render);
  $('#so-pendentes').addEventListener('change', renderLista);
  $('#btn-usuario').addEventListener('click', pedirUsuario);
  $('#btn-atualizar').addEventListener('click', carregarTudo);
  $('#ano').addEventListener('change', (e) => {
    if (algumRascunho() && !confirm('Há alterações não salvas. Trocar de ano e descartá-las?')) { e.target.value = est.ano; return; }
    est.ano = +e.target.value; est.dim = 0; est.rascunho = {}; carregarTudo();
  });
  window.addEventListener('beforeunload', (e) => { if (algumRascunho()) e.preventDefault(); });
}

async function usarPasta(h, caminho) {
  est.raiz = h;
  est.rascunho = {};
  est.logProblema = '';
  $('#pasta-atual').textContent = `Evidências em ${caminho}`;
  $('#btn-atualizar').hidden = false;
  aviso('');
  await carregarTudo();
}

/** Ao abrir: pergunta ao servidor.py qual é a pasta das evidências e já lê tudo. */
async function iniciar() {
  const anos = Object.keys(window.IOSPD || {}).map(Number).sort((a, b) => b - a);
  if (!anos.length) { aviso('Nenhum arquivo em dados/ foi carregado.', true); return; }
  est.ano = anos[0];
  $('#ano').innerHTML = anos.map((a) => `<option>${a}</option>`).join('');
  $('#btn-usuario').textContent = usuario() ? `Usuário: ${usuario()}` : 'Informar nome';
  ligar();
  render();
  try {
    const info = await (await fetch('/api/info')).json();
    await usarPasta(pastaServidor('', info.nome), info.pasta);
    vigiar(info.intervalo || 30);
  } catch {
    aviso('O painel precisa ser aberto pelo arquivo abrir-painel.bat (ele liga o acesso à pasta da rede).', true);
  }
}

iniciar();
