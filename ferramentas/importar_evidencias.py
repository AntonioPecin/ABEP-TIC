"""Copia uma pasta de evidências no formato antigo para o formato do painel.

Uso:
  python ferramentas/importar_evidencias.py "<origem>" "<destino>" 2026            (só simula e mostra o relatório)
  python ferramentas/importar_evidencias.py "<origem>" "<destino>" 2026 --copiar   (copia de verdade)

Origem: pasta com "Dimensao I\\1.1 Possui ...\\arquivos". Nunca é alterada.
Destino: a mesma pasta que será escolhida no painel. Fica <destino>\\<ano>\\Dimensao I\\1.1\\...
Não sobrescreve nada: arquivo ou resposta.json que já existe no destino é pulado.

Regras de nome (o padrão que a equipe já usava):
  "1.1a - X.pdf"      -> qualificador 1.1a          "1.1b e c - X.pdf" -> 1.1b e 1.1c ("x e y" = conjunção)
  "1.2a,b,c - X.pdf"  -> 1.2a, 1.2b, 1.2c          "5.2a b d e f - X" -> a, b, d, e, f
  "I.7d - X.mp4"      -> 1.7d (algarismo romano antigo, vale se o número bate com a pasta)
  "II.10 - X.mp4" dentro de 2.7 -> número não bate: fica no indicador 2.7
  sem código          -> indicador ("1.1 - X.pdf")
Links: URLs de arquivos .txt/.url viram links no resposta.json, no qualificador citado na mesma linha ou na linha
anterior; sem código, vão para o indicador. O .txt também é copiado.
"""
import csv
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
RE_PASTA = re.compile(r"^(\d)\.(\d{1,2})\b")
# código no início do nome: 1.1 / 1.10 / I.7 / IV.7 / 3.6. ; depois letras dos qualificadores
RE_PREFIXO = re.compile(r"^(\d|[IVX]+)\.(\d{1,2})(?!\d)\.?")
# 1ª letra pode ser maiúscula ("4.7C"); as demais minúsculas, separadas por espaço, vírgula ou "-" colado ("b-c")
RE_LETRAS = re.compile(r"^\s*([a-hA-H](?![A-Za-zÀ-ú0-9])(?:(?:[\s,]+|-)[a-h](?![A-Za-zÀ-ú0-9]))*)")
RE_URL = re.compile(r"https?://[^\s<>\"']+")
RE_COD_LINHA = re.compile(r"\b(\d)\.(\d{1,2})\.?\s?([a-h])\b")


def carregar_dados(ano):
    txt = (RAIZ / "dados" / f"{ano}.js").read_text(encoding="utf-8")
    corpo = txt[txt.index(f"window.IOSPD[{ano}] = ") + len(f"window.IOSPD[{ano}] = "):].rstrip().rstrip(";")
    dados = json.loads(corpo)
    return {i["codigo"]: (d["id"], i) for d in dados["dimensoes"] for i in d["indicadores"]}


def letras_do_nome(resto):
    """'a e b - X' -> (['a','b'], ' - X'). Devolve ([], resto) se não há letras."""
    m = RE_LETRAS.match(resto)
    if not m:
        return [], resto
    toks = re.findall(r"[a-hA-H]", m.group(1))
    toks = [t.lower() for t in toks]
    if len(toks) == 3 and toks[1] == "e":  # "a e b": o "e" é conjunção
        toks = [toks[0], toks[2]]
    return toks, resto[m.end():]


def classificar(nome, cod, ind):
    """Devolve (novo_nome, [qualificadores], aviso)."""
    validos = {q["codigo"] for q in ind["qualificadores"]}
    dim_pasta, num_pasta = cod.split(".")
    m = RE_PREFIXO.match(nome)
    if not m or m.group(2) != num_pasta or (m.group(1).isdigit() and m.group(1) != dim_pasta):
        aviso = f"código '{m.group(0)}' não bate com {cod}" if m else ""
        return f"{cod} - {nome}", [], aviso
    letras, resto = letras_do_nome(nome[m.end():])
    quals = [f"{cod}{l}" for l in letras]
    fora = [q for q in quals if q not in validos]
    quals = [q for q in quals if q in validos]
    resto = resto.lstrip(" -_–")
    if not resto or resto.startswith("."):  # ex.: "1.5.pdf"
        resto = nome
    sufixo = "-".join(q[len(cod):] for q in quals)
    aviso = f"letra(s) sem qualificador no PDF: {', '.join(fora)}" if fora else ""
    return f"{cod}{sufixo} - {resto}", quals, aviso


def links_do_arquivo(caminho, cod, validos):
    """{alvo: [urls]} onde alvo é um qualificador ou o próprio indicador."""
    try:
        texto = caminho.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        texto = caminho.read_text(encoding="cp1252", errors="replace")
    saida, ctx = {}, []
    for linha in texto.splitlines():
        if not linha.strip():
            continue
        codigos = [f"{a}.{b}{c}" for a, b, c in RE_COD_LINHA.findall(linha)]
        codigos = [c for c in codigos if c in validos]
        urls = RE_URL.findall(linha)
        if codigos:
            ctx = codigos
        elif not urls:
            ctx = []  # linha de texto sem código encerra o contexto anterior
        for u in urls:
            for alvo in (codigos or ctx or [cod]):
                lst = saida.setdefault(alvo, [])
                if u.rstrip(".,;") not in lst:
                    lst.append(u.rstrip(".,;"))
    return saida


HASH_INICIAL = "0" * 64


def hash_linha(anterior, campos):
    """Mesmo cálculo de app.js (hashLinha): SHA-256 de hash anterior + 6 campos, separados por \\x1f."""
    return hashlib.sha256("\x1f".join([anterior, *campos]).encode("utf-8")).hexdigest()


def registrar(csv_path, linhas):
    """Acrescenta ao log-evidencias.csv, encadeado por hash, no mesmo formato do painel (app.js: registrar).
    Só acrescenta; nunca reescreve linha existente."""
    anterior = HASH_INICIAL
    if csv_path.exists():
        with open(csv_path, encoding="utf-8-sig", newline="") as f:
            existentes = list(csv.reader(f, delimiter=";"))[1:]
        if existentes:
            anterior = existentes[-1][7]
    novo = not csv_path.exists()
    with open(csv_path, "a", encoding="utf-8-sig" if novo else "utf-8", newline="") as f:
        w = csv.writer(f, delimiter=";", lineterminator="\r\n")
        if novo:
            w.writerow(["data_hora", "colaborador", "acao", "indicador", "qualificador", "evidencia", "hash_anterior", "hash"])
        for campos in linhas:
            h = hash_linha(anterior, campos)
            w.writerow([*campos, anterior, h])
            anterior = h


def caminho_longo(p):
    """Prefixo \\\\?\\ do Windows: sem ele, caminho com mais de 260 caracteres some em silêncio."""
    s = str(Path(p).resolve())
    if s.startswith("\\\\?\\"):
        return Path(s)
    return Path("\\\\?\\UNC\\" + s[2:] if s.startswith("\\\\") else "\\\\?\\" + s)


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    origem, destino, ano = caminho_longo(sys.argv[1]), caminho_longo(sys.argv[2]), int(sys.argv[3])
    copiar = "--copiar" in sys.argv
    indicadores = carregar_dados(ano)
    rel = {"copiados": 0, "pulados": 0, "bytes": 0, "sem_qualif": [], "avisos": [], "ignorados": []}
    registro, agora = [], datetime.now().astimezone().isoformat(timespec="seconds")

    for dim_dir in sorted(p for p in origem.iterdir() if p.is_dir()):
        if not dim_dir.name.lower().startswith("dimens"):
            rel["ignorados"].append(dim_dir.name + "\\")
            continue
        for ind_dir in sorted(p for p in dim_dir.iterdir() if p.is_dir()):
            m = RE_PASTA.match(ind_dir.name)
            cod = f"{m.group(1)}.{m.group(2)}" if m else None
            if cod not in indicadores:
                rel["ignorados"].append(f"{dim_dir.name}\\{ind_dir.name}\\ (código não está no PDF de {ano})")
                continue
            dim_id, ind = indicadores[cod]
            validos = {q["codigo"] for q in ind["qualificadores"]}
            alvo_dir = destino / str(ano) / f"Dimensao {dim_id}" / cod
            resposta = {"atende": False, "opcao": "", "qualificadores": {}, "links": [], "obs": ""}
            for arq in sorted(p for p in ind_dir.rglob("*") if p.is_file()):
                if arq.name.lower() in ("thumbs.db", "desktop.ini") or arq.name.startswith("~$"):
                    continue
                # arquivo em subpasta: o nome da subpasta entra no nome
                nome = " - ".join(arq.relative_to(ind_dir).parts)
                novo, quals, aviso = classificar(nome, cod, ind)
                if aviso:
                    rel["avisos"].append(f"{cod}: {nome} -> {aviso}")
                if not quals:
                    rel["sem_qualif"].append(f"{cod}: {nome}")
                for q in quals:
                    resposta["qualificadores"].setdefault(q, {"atende": True, "links": []})
                if arq.suffix.lower() in (".txt", ".url"):
                    for alvo, urls in links_do_arquivo(arq, cod, validos).items():
                        destino_links = resposta["links"] if alvo == cod else \
                            resposta["qualificadores"].setdefault(alvo, {"atende": True, "links": []})["links"]
                        destino_links.extend(u for u in urls if u not in destino_links)
                final = alvo_dir / novo
                if final.exists():
                    rel["pulados"] += 1
                    continue
                rel["copiados"] += 1
                rel["bytes"] += arq.stat().st_size
                if copiar:
                    alvo_dir.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(arq, final)
                    registro.append([agora, "Importação", "anexou", cod, ",".join(quals), novo])
            # marca como atendido o que tem evidência; múltipla escolha e opções ficam para a pessoa decidir
            tem_algo = any(alvo_dir.glob("*")) if copiar else True
            if not ind["opcoes"] and "múltipla" not in ind["tipo"].lower() and tem_algo:
                resposta["atende"] = True
            resposta.update(indicador=cod, ano=ano, editadoPor="Importação",
                            editadoEm=datetime.now().astimezone().isoformat(timespec="seconds"),
                            obs=f"Importado de \"{ind_dir.name}\". Conferir marcações e qualificadores.")
            arq_resp = alvo_dir / "resposta.json"
            if arq_resp.exists():
                rel["avisos"].append(f"{cod}: resposta.json já existe no destino, mantido")
            elif copiar:
                alvo_dir.mkdir(parents=True, exist_ok=True)
                arq_resp.write_text(json.dumps(resposta, ensure_ascii=False, indent=2), encoding="utf-8")
                for u in resposta["links"]:
                    registro.append([agora, "Importação", "adicionou link", cod, "", u])
                for q, d in resposta["qualificadores"].items():
                    for u in d["links"]:
                        registro.append([agora, "Importação", "adicionou link", cod, q, u])

    if registro:
        registrar(destino / str(ano) / "log-evidencias.csv", registro)
    for f in sorted(p for p in origem.iterdir() if p.is_file()):
        rel["ignorados"].append(f.name)
    modo = "COPIADO" if copiar else "SIMULAÇÃO (nada copiado; use --copiar)"
    print(f"{modo}: {rel['copiados']} arquivos, {rel['bytes'] / 2**20:,.0f} MB; {rel['pulados']} já existiam")
    for titulo, chave in (("Avisos", "avisos"), ("Sem qualificador (ficam no indicador)", "sem_qualif"),
                          ("Ignorados na origem", "ignorados")):
        print(f"\n{titulo} ({len(rel[chave])}):")
        for x in rel[chave]:
            print("  " + x)


if __name__ == "__main__":
    main()
