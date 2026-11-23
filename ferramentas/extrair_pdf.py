"""Gera dados/AAAA.js a partir do PDF "Lista de indicadores" da ABEP-TIC.

Uso:  python ferramentas/extrair_pdf.py "<PDF>" 2027
Precisa de: pip install pymupdf

O PDF é uma tabela de 3 colunas (Indicador | Qualificadores | Evidências).
O script lê cada linha com a posição na página, descobre a coluna pela borda da
tabela e corta os indicadores pelo código em negrito (ex.: "1.3 Existe ...").
O resultado é um RASCUNHO: confira com o PDF antes de usar (roteiro em ESTRUTURA-ABEP-TIC.md, seção 8).
"""
import json
import re
import sys
from pathlib import Path

import pymupdf

RE_INDICADOR = re.compile(r"^(\d)\.(\d{1,2})\s+(.*)")
RE_QUALIF = re.compile(r"^(\d)\.(\d{1,2})\.?\s?([a-z])[.)]?\s+(.*)")
RE_PARA_SUB = re.compile(r"PARA A SUBPERGUNTA\s+(\d)\.(\d{1,2})\.?\s?([a-z])", re.I)
RE_DIMENSAO = re.compile(r"^Dimens[ãa]o\s+([IVX]+)\s*[-–]\s*(.+)")
RE_VALOR = re.compile(r"^Valor de cada indicador:\s*(.+)")
RE_OPCAO = re.compile(r"^\(?([a-h])\)\s+(.*)")  # opções de resposta "a) ..." (única escolha / faixas)
ROMANOS = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8}


def linhas_da_pagina(pagina):
    """Linhas de texto com x, y, negrito, itálico. Junta o marcador '•' à linha ao lado."""
    linhas = []
    for bloco in pagina.get_text("dict")["blocks"]:
        for l in bloco.get("lines", []):
            spans = [s for s in l["spans"] if s["text"].strip()]
            if not spans:
                continue
            texto = "".join(s["text"] for s in l["spans"]).strip()
            fonte = spans[-1]["font"]
            linhas.append({
                "x": l["bbox"][0], "y": round(l["bbox"][1], 1), "t": texto,
                "negrito": "Bold" in fonte or bool(spans[-1]["flags"] & 16),
                "italico": "Italic" in fonte or bool(spans[-1]["flags"] & 2),
                "simbolo": "Symbol" in spans[0]["font"],
            })
    # marcador de lista ("•", "o") vem como linha separada, quase na mesma altura do texto
    marcas = [l for l in linhas if l["simbolo"] or l["t"] in MARCADORES]
    saida = []
    for l in linhas:
        if l in marcas:
            continue
        m = next((m for m in marcas if abs(m["y"] - l["y"]) < 3 and 0 < l["x"] - m["x"] < 40), None)
        if m:
            l = dict(l, t=("◦ " if m["t"] == "o" else "• ") + l["t"], x=m["x"])
        saida.append(l)
    saida.sort(key=lambda l: (l["y"], l["x"]))
    return saida


MARCADORES = ("•", "o", "▪", "◦", "-", "")


def limites_colunas(pagina):
    """x onde começam as colunas 2 e 3, lido das bordas da tabela."""
    tabs = pagina.find_tables().tables
    if not tabs:
        return None
    xs = sorted({round(c[0]) for t in tabs for c in t.cells if c})
    # junta bordas muito próximas
    cols = [xs[0]]
    for x in xs[1:]:
        if x - cols[-1] > 20:
            cols.append(x)
    return (cols[1], cols[2]) if len(cols) >= 3 else None, min(t.bbox[1] for t in tabs)


def para_texto(linhas):
    """Junta linhas quebradas em parágrafos. Negrito vira **...**, lista vira '• '."""
    paras, atual, ultimo_y = [], None, None
    for l in linhas:
        t = l["t"]
        novo = (
            atual is None
            or t.startswith(("•", "◦"))
            or re.match(r"^\(?[ivx]+\)\s", t)
            or RE_OPCAO.match(t)
            or re.match(r"^Op[çc][ãa]o\s*\(", t)
            or l["negrito"] != atual["negrito"]
            or (ultimo_y is not None and l["y"] - ultimo_y > 16)
            or l.get("quebra")
        )
        if novo:
            atual = {"negrito": l["negrito"], "t": t}
            paras.append(atual)
        else:
            atual["t"] += " " + t
        ultimo_y = l["y"]
    out = []
    for p in paras:
        t = re.sub(r"\s+", " ", p["t"]).strip()
        out.append(f"**{t}**" if p["negrito"] and not t.startswith("•") else t)
    return "\n".join(out)


def extrair(pdf):
    doc = pymupdf.open(pdf)
    dimensoes, ind = [], None
    for pagina in doc:
        lim = limites_colunas(pagina)
        if not lim or not lim[0]:
            continue
        (c2, c3), topo = lim
        for l in linhas_da_pagina(pagina):
            t = l["t"]
            m = RE_DIMENSAO.match(t)
            if m and l["y"] < topo:
                dimensoes.append({"id": m.group(1), "nome": m.group(2).strip(), "valorIndicador": "", "indicadores": []})
                ind = None
                continue
            m = RE_VALOR.match(t)
            if m and l["y"] < topo:
                dimensoes[-1]["valorIndicador"] = m.group(1).strip()
                continue
            if l["y"] < topo and dimensoes and dimensoes[-1]["valorIndicador"] and not dimensoes[-1]["indicadores"]:
                dimensoes[-1]["valorIndicador"] += " " + t  # nota do valor quebrada em 2 linhas
                continue
            if l["y"] < topo + 14 and t in ("Indicador", "Qualificadores / subperguntas", "Tipos de evidências aceitas"):
                continue
            if l["y"] < topo or not dimensoes:
                continue
            col = 0 if l["x"] < c2 - 5 else 1 if l["x"] < c3 - 5 else 2
            if col == 0 and l["negrito"] and RE_INDICADOR.match(t):
                m = RE_INDICADOR.match(t)
                ind = {"codigo": f"{m.group(1)}.{m.group(2)}", "_p": [], "_tipo": [], "_q": [], "_e": []}
                dimensoes[-1]["indicadores"].append(ind)
                l = dict(l, t=m.group(3))
            if ind is None:
                continue
            if col == 0:
                (ind["_tipo"] if l["italico"] else ind["_p"]).append(l)
            elif col == 1:
                ind["_q"].append(l)
            else:
                ind["_e"].append(l)
    for d in dimensoes:
        for i in d["indicadores"]:
            montar(i)
    return dimensoes


def montar(i):
    i["pergunta"] = re.sub(r"\s+", " ", " ".join(l["t"] for l in i.pop("_p"))).strip()
    i["tipo"] = re.sub(r"\s+", " ", " ".join(l["t"] for l in i.pop("_tipo"))).strip()
    # qualificadores: cada linha que começa com código abre um novo
    enunciado, quals, opcoes = [], [], []
    for l in i.pop("_q"):
        m = RE_QUALIF.match(l["t"])
        o = RE_OPCAO.match(l["t"])
        if m:
            quals.append({"codigo": f"{m.group(1)}.{m.group(2)}{m.group(3)}", "_l": [dict(l, t=m.group(4))]})
        elif o and not quals:
            opcoes.append({"codigo": o.group(1), "_l": [dict(l, t=o.group(2))]})
        elif quals:
            quals[-1]["_l"].append(l)
        elif opcoes:
            opcoes[-1]["_l"].append(l)
        elif l["t"] != "N/A":
            enunciado.append(l)
    i["enunciado"] = para_texto(enunciado)
    i["opcoes"] = [{"codigo": o["codigo"], "texto": para_texto(o["_l"]).replace("\n", " ")} for o in opcoes]
    i["qualificadores"] = [{"codigo": q["codigo"], "texto": para_texto(q["_l"]).replace("\n", " "), "evidencias": ""} for q in quals]
    # evidências: blocos "PARA A SUBPERGUNTA x" vão para o qualificador
    geral, alvo, blocos = [], None, {}
    for l in i.pop("_e"):
        m = RE_PARA_SUB.search(l["t"])
        if m:
            alvo = f"{m.group(1)}.{m.group(2)}{m.group(3)}"
            blocos[alvo] = []
            continue
        (blocos[alvo] if alvo else geral).append(l)
    i["evidencias"] = para_texto(geral)
    por_codigo = {q["codigo"]: q for q in i["qualificadores"]}
    for cod, ls in blocos.items():
        if cod in por_codigo:
            por_codigo[cod]["evidencias"] = para_texto(ls)
        else:
            i["evidencias"] += f"\n**PARA A SUBPERGUNTA {cod}:**\n" + para_texto(ls)


def main():
    pdf, ano = sys.argv[1], sys.argv[2]
    dados = {"ano": int(ano), "fonte": Path(pdf).name, "dimensoes": extrair(pdf)}
    destino = Path(__file__).resolve().parent.parent / "dados" / f"{ano}.js"
    destino.parent.mkdir(exist_ok=True)
    corpo = json.dumps(dados, ensure_ascii=False, indent=2)
    destino.write_text(f"// Gerado por ferramentas/extrair_pdf.py a partir de {dados['fonte']}. Revisado à mão: ver ESTRUTURA-ABEP-TIC.md\n"
                       f"window.IOSPD = window.IOSPD || {{}};\nwindow.IOSPD[{ano}] = {corpo};\n", encoding="utf-8")
    n = sum(len(d["indicadores"]) for d in dados["dimensoes"])
    print(f"{destino}: {len(dados['dimensoes'])} dimensões, {n} indicadores")
    for d in dados["dimensoes"]:
        for i in d["indicadores"]:
            aviso = "" if i["tipo"] else "  <- SEM TIPO"
            print(f"  {i['codigo']:5} {len(i['qualificadores']):2} qualif.  {i['tipo'][:45]}{aviso}")


if __name__ == "__main__":
    main()
