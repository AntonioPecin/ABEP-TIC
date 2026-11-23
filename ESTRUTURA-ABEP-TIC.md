# Estrutura do índice ABEP-TIC (IOSPD)

> **Para o agente de IA:** leia este arquivo antes de transformar o PDF anual da ABEP-TIC em `dados/AAAA.js`.
> Ele diz como o índice é organizado, como o PDF é montado e como cada parte vira dado no painel. O código do painel
> (`app.js`) não muda de um ano para o outro: o trabalho anual é só gerar e revisar `dados/AAAA.js`.

## 1. O que é

A **ABEP-TIC** (Associação Brasileira de Entidades Estaduais de Tecnologia da Informação e Comunicação) publica todo ano
o **Índice de Oferta de Serviços Públicos Digitais (IOSPD)**, com apoio do BID e do Tony Blair Institute. O índice
avalia cada Unidade da Federação (UF). Para cada indicador, a UF envia **evidências** (link, PDF, vídeo, print) que o
**Comitê Avaliador** confere.

O documento de entrada é o **"Anexo I – Lista de indicadores do IOSPD AAAA"** (PDF). Em 2026:
`IOSPD 2026_Lista atualizada de indicadores.pdf`, 30 páginas.

## 2. Hierarquia

```
Índice (IOSPD AAAA)
└── Dimensão (I, II, III…)            nome + valor de cada indicador em pontos
    └── Indicador (1.1, 1.2…)         pergunta + tipo + evidências aceitas
        ├── Qualificador / subpergunta (1.1a, 1.1b…)   texto + evidências próprias (às vezes)
        └── Opção de resposta (a, b, c, d)               só nos indicadores de única escolha
```

| Nível | Código | Exemplo (2026) |
|---|---|---|
| Índice | ano | IOSPD 2026 |
| Dimensão | algarismo romano | `I` – Capacidades de Ofertar Serviços Digitais |
| Indicador | `<nº da dimensão>.<nº>` | `1.1` Possui estratégia de Governo Digital vigente em 2026? |
| Qualificador | código do indicador + letra | `1.1a` Define metas quantificáveis? |
| Opção | letra | `1.11` opção `c)` Equipe formalizada e operando com processos documentados |

O número antes do ponto é a dimensão em algarismo arábico (`1.x` = Dimensão I, `2.x` = Dimensão II…).

### Retrato de 2026 (para comparar com o ano novo)

| Dimensão | Nome | Pontos por indicador | Indicadores | Qualificadores |
|---|---|---|---|---|
| I | Capacidades de Ofertar Serviços Digitais | 2,5 | 12 | 32 |
| II | Oferta de Serviços Digitais | 2,5 | 12 | 8 |
| III | Normatização sobre Modernização para a Oferta de Serviços Públicos Digitais | 1,66* | 6 | 14 |
| IV | Inclusividade na Oferta de Serviços Digitais | 2,5 | 8 | 11 |
| V | Inovação na Oferta de Serviços Digitais | 1,66* | 6 | 12 |
| **Total** | | | **44** | **77** |

\* O PDF explica que o valor tem mais casas decimais para a dimensão somar 10%.

## 3. Tipos de indicador

O tipo aparece em itálico, embaixo da pergunta, na 1ª coluna do PDF. O painel decide a tela pelo tipo.

| Tipo (texto exato do PDF) | 2026 | O que a UF responde | Como o painel mostra |
|---|---|---|---|
| Indicador binário sem qualificadores | 22 | Sim/não, com evidência | Bloco "Evidências do indicador" (conta como preenchido quando tem anexo ou link) |
| Indicador binário com qualificadores | 8 | Sim/não + atesta cada qualificador | Bloco do indicador + um checkbox por qualificador |
| Indicador de múltipla escolha | 9 | Marca os qualificadores que se aplicam | Um checkbox por qualificador (bloco do indicador vai para o fim) |
| Indicador de única escolha | 1 (1.11) | Escolhe uma opção a/b/c/d | Botões de opção + evidência |
| Indicador com gradação/faixas | 4 (2.11, 4.1, 4.4, 4.5) | Valor em faixas, em geral calculado pelo Comitê | Bloco de evidência; se o PDF diz que não precisa enviar, selo "Não exige evidência" |

Se aparecer um **tipo novo**, o painel ainda funciona (cai no comportamento de "binário"), mas avise a pessoa: pode
precisar de ajuste em `app.js` (`corpo()` e `situacao()`).

## 4. Como o PDF é montado

Cada página é uma **tabela de 3 colunas**, com cabeçalho repetido:

| Indicador | Qualificadores / subperguntas | Tipos de evidências aceitas |
|---|---|---|
| código + pergunta (negrito) e tipo (itálico) | qualificadores `1.1a.`, `1.2.a.` ou opções `a)` | texto livre com evidência obrigatória, complementar e regras |

Antes da tabela de cada dimensão vem o título (`Dimensão I - …`) e a linha `Valor de cada indicador: 2,5 pontos`.

Armadilhas conhecidas (todas já tratadas em `ferramentas/extrair_pdf.py`; confira se o PDF novo mudou alguma):

- **Texto atravessa colunas e páginas.** Extrair o texto "corrido" mistura a coluna 3 de um indicador com o
  seguinte. O script lê pela posição na página e corta os indicadores pelo código em negrito.
- **Formato do código do qualificador varia:** `1.1a.`, `1.2.a.`, `5.2.c` (sem ponto final). Todos viram `1.1a`.
- **Evidência por subpergunta:** na coluna 3, blocos que começam com `PARA A SUBPERGUNTA 1.5a` pertencem ao
  qualificador `1.5a`, não ao indicador.
- **Opções de única escolha** (`a) … b) …`) ficam na coluna 2, depois de "Opções de resposta:". As regras por opção
  ficam na coluna 3 (`PARA A OPÇÃO (b)`).
- **Marcadores de lista:** `•` vira `• ` e o sub-marcador `o` (fonte Courier) vira `◦ `.
- **Indicador sem qualificador** tem `N/A` na coluna 2.
- **Faixas dos indicadores de gradação** estão no texto da coluna 3, não na coluna 2.

## 5. Evidências

Na coluna 3, o PDF separa:

- **EVIDÊNCIA OBRIGATÓRIA** – sem ela o indicador não pontua (ex.: URL do decreto da estratégia).
- **EVIDÊNCIAS COMPLEMENTARES** – reforçam qualificadores que o documento principal não cobre.
- **Exemplos de tipos de evidências aceitas** – lista de alternativas; uma basta para a subpergunta.
- **Sem envio** – frases como "Não é necessário o envio de evidência" ou "A UF não deverá enviar evidência": o
  Comitê usa dado público. O painel reconhece pelo começo do texto (regex `SEM_EVIDENCIA` em `app.js`). Se o PDF
  novo usar outra frase, ajuste o regex.

## 6. Como vira dado: `dados/AAAA.js`

Um arquivo por ano. É JavaScript (não JSON) porque a página também precisa abrir sem servidor de arquivos:

```js
window.IOSPD = window.IOSPD || {};
window.IOSPD[2027] = {
  "ano": 2027,
  "fonte": "IOSPD 2027_Lista de indicadores.pdf",
  "dimensoes": [
    {
      "id": "I",                                   // algarismo romano, igual ao PDF
      "nome": "Capacidades de Ofertar Serviços Digitais",
      "valorIndicador": "2,5 pontos",              // texto da linha "Valor de cada indicador:"
      "indicadores": [
        {
          "codigo": "1.1",
          "pergunta": "Possui estratégia de Governo Digital vigente em 2027?",
          "tipo": "Indicador binário com qualificadores",   // texto exato do PDF (seção 3)
          "enunciado": "",                         // texto da coluna 2 antes dos qualificadores (ex.: "Tem mandato para:")
          "opcoes": [],                            // só única escolha: [{ "codigo": "a", "texto": "…" }]
          "qualificadores": [
            { "codigo": "1.1a", "texto": "Define metas quantificáveis?", "evidencias": "" }
          ],
          "evidencias": "**EVIDÊNCIA OBRIGATÓRIA:**\n• URL/link do decreto…"
        }
      ]
    }
  ]
};
```

Formato dos textos (`evidencias`, `enunciado`): uma linha por parágrafo; `**…**` = negrito do PDF; `• ` = item de
lista; `◦ ` = subitem. `qualificadores[].evidencias` só é preenchido quando o PDF tem bloco `PARA A SUBPERGUNTA` daquele
qualificador; isso também liga o selo "Falta evidência" para ele.

## 7. Como vira pasta: evidências salvas

O painel grava na pasta configurada em `config.json` (`caminho_rede`), seguindo a mesma hierarquia:

```
<caminho_rede>\
  2027\                                  ano do índice
    Dimensao I\                          dimensão (romano)
      1.1\                               indicador
        resposta.json                    marcações, opção, links, observação, quem salvou cada item
        1.1 - Decreto estratégia.pdf     anexo do indicador
        1.1a - Plano de metas.pdf        anexo do qualificador 1.1a
        1.1b-c - Decreto 16.713.pdf      anexo que vale para 1.1b e 1.1c
    _backup\                             evidências removidas ou substituídas (nunca apagadas)
    log-evidencias.csv                   log só de acréscimo, encadeado por hash
```

Ano novo = pasta de ano nova; os anos anteriores ficam intactos. Por isso o **código do indicador** é a chave de tudo:
se a ABEP renumerar (ex.: o 1.5 de 2026 vira 1.6 em 2027), as pastas de 2026 continuam com o número antigo.

## 8. Roteiro para o agente no ano novo

1. Rodar `python ferramentas/extrair_pdf.py "<PDF do ano>" AAAA` (precisa de `pip install pymupdf`). Ele grava
   `dados/AAAA.js` e lista cada indicador com tipo e nº de qualificadores. Linha com `SEM TIPO` = problema de leitura.
2. Conferir `dados/AAAA.js` contra o PDF, **indicador por indicador**: código, pergunta, tipo, enunciado, opções,
   qualificadores (código e texto) e o texto de evidências, inclusive os blocos `PARA A SUBPERGUNTA` e `PARA A OPÇÃO`.
   Corrigir direto no arquivo.
3. Conferir a contagem: qualificadores no PDF × no arquivo (busque todos os códigos `N.Nx` no texto do PDF), nenhum
   texto vazio, nenhum indicador sem evidência a não ser os de "sem envio".
4. Comparar com o ano anterior (`dados/AAAA-1.js`) e entregar à pessoa a lista: indicadores **novos**, **removidos**,
   **reformulados** (pergunta ou qualificadores mudaram) e **renumerados**. A equipe usa isso para saber quais
   evidências do ano anterior reaproveitar.
5. Se surgir tipo de indicador novo, frase nova de "sem envio" ou formato novo de código: avisar a pessoa e apontar o
   trecho de `app.js` ou `extrair_pdf.py` que precisa de ajuste. Não mudar o código sem pedir.
6. Adicionar `<script src="dados/AAAA.js"></script>` no `index.html`, junto das outras linhas de dados.
7. Atualizar a tabela "Retrato" da seção 2 com os números do ano novo.

Não altere `dados/` de anos anteriores: eles descrevem as respostas já salvas nas pastas daquele ano.
