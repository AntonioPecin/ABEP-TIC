# Painel de Evidências ABEP-TIC

Página local para organizar as evidências do Índice de Oferta de Serviços Públicos Digitais (IOSPD) da ABEP-TIC.
Mostra o que o PDF da ABEP pede em cada indicador, permite marcar o que o Estado atende e guarda os anexos numa pasta
escolhida por quem usa.

## Como usar

1. Dê dois cliques em **`abrir-painel.bat`**. Ele abre o painel no navegador e já lê as evidências da pasta oficial
   `\\s0101\SGD\14-SETDIG\Setdig\ABEP-TIC`. Ninguém precisa procurar a pasta.
   - Deixe a janela preta aberta enquanto usa o painel. Fechar a janela desliga o painel.
   - Precisa do Python instalado na máquina (só a instalação padrão, sem pacotes extras).
   - O caminho da pasta fica em `caminho_rede`, no `config.json` (barras duplicadas: `\\\\s0101\\SGD\\...`).
     Ao abrir, o painel confere se a pasta existe e se você pode ler e gravar nela; se não, mostra o erro na janela
     preta e não abre. Para testar em outra pasta:
     `abrir-painel.bat "C:\caminho\da\pasta-de-teste"`.
   - Abrir o `index.html` direto não funciona: o acesso à pasta da rede é feito pelo `servidor.py`.
2. A página confere a pasta sozinha a cada 30 segundos (`intervalo_segundos` no `config.json`, mínimo 5). Se alguém
   anexou, apagou ou salvou algo (pelo painel ou direto pelo Windows), ela relê a pasta e avisa no topo, por exemplo:
   "Pasta atualizada às 07:41 — entrou: 1.4 - Decreto.pdf; saiu: 1.3 - Antigo.pdf". As suas próprias alterações
   não geram aviso. Enquanto você digita num campo, a conferência espera a próxima rodada. O botão **Atualizar**
   continua para quem não quer esperar.
3. Informe seu nome uma vez. Ele fica registrado em cada alteração.
4. Abra um indicador, marque o que o Estado atende e anexe arquivos ou cole links.
5. Cada item tem o próprio botão **Salvar**: o bloco "Evidências do indicador" (anexos, links e observação do
   indicador) e cada qualificador (1.1a, 1.1b…).
   O botão aparece quando o item muda e grava só aquele item. Até lá nada vai para a pasta: o indicador mostra o selo
   **Não salvo**, os anexos novos aparecem como "a enviar" e os removidos como "será removido". **Descartar** volta o
   item ao que estava salvo. O navegador avisa se você tentar fechar a página com alterações não salvas.

## Como os arquivos ficam na pasta

```
<pasta escolhida>\
  2026\
    Dimensao I\
      1.5\
        resposta.json            marcações, links, observação, quem alterou e quando
        1.5a - Decreto 123.pdf   anexo do qualificador 1.5a
        1.5 - Portaria.pdf       anexo do indicador
    _backup\                     cópia de toda evidência removida ou substituída (nada é apagado de vez)
    log-evidencias.csv           log de toda evidência adicionada ou removida (abre no Excel)
```

### Backup das evidências (`_backup`)

- Toda evidência removida no painel vai para `<ano>\_backup\`, no mesmo caminho de antes, com data e hora na frente do
  nome. Ex.: `2026\_backup\Dimensao I\1.3\2026-11-23_08-22-28 1.3 - Decreto.pdf`.
- Se alguém anexar um arquivo com o mesmo nome de um que já existe, a versão antiga também vai para o backup antes de
  ser substituída.
- Quem faz isso é o `servidor.py`: ele nunca apaga uma evidência, só move para o backup. O painel não consegue alterar
  nem apagar nada dentro de `_backup`.
- Para recuperar uma evidência, copie o arquivo do `_backup` de volta para a pasta do indicador, tirando a data do nome.

### Log de evidências (`log-evidencias.csv`)

- Cada **Salvar** acrescenta uma linha por ato: `anexou`, `removeu` (arquivo foi para o `_backup`),
  `adicionou link` ou `removeu link`. Colunas: `data_hora;colaborador;acao;indicador;qualificador;evidencia;hash_anterior;hash`.
- O painel só **acrescenta** linhas no fim. Nenhuma tela edita ou apaga registro.
- **Proteção contra alteração:** cada linha leva um código (hash SHA-256) calculado a partir da linha anterior. Se
  alguém editar, apagar ou inserir uma linha por fora (Excel, Bloco de Notas), a corrente quebra. Ao abrir, a página
  confere o log inteiro e mostra no topo, em vermelho, qual linha foi mexida. Apagar linhas do fim também é detectado:
  cada navegador lembra quantos registros já viu.
- Pelo painel, o log só cresce: o `servidor.py` recusa sobrescrever ou apagar o `log-evidencias.csv` e só acrescenta
  linhas no fim.
- **Limite:** quem abrir a pasta da rede pelo Windows ainda consegue mexer no arquivo; a página detecta, mas não impede.
  Para impedir de verdade, peça à TI para deixar as pessoas só acrescentarem dados nesse arquivo (sem alterar nem
  excluir) na pasta de rede. O `servidor.py` grava o log só acrescentando, então essa permissão é suficiente.
- Se duas pessoas salvarem exatamente ao mesmo tempo, o painel confere se a linha entrou e tenta de novo. Em um caso
  raro, a linha de uma delas pode se perder. Nesse caso, o navegador dessa pessoa mostra o aviso de log alterado na
  próxima vez que abrir.
- Na página, cada anexo mostra "anexado por Fulano em dd/mm", lido do log.

- O nome do arquivo começa pelo código do qualificador ou do indicador. Um arquivo copiado à mão para a pasta com esse
  prefixo também aparece na página.
- Um arquivo que vale para mais de um qualificador leva as letras separadas por hífen: `1.1b-c - Decreto.pdf` aparece
  em 1.1b e em 1.1c. Remover esse arquivo tira dos dois.

## Importar uma pasta de evidências antiga

Copia uma pasta no formato antigo (`Dimensao I\1.1 Possui ...\arquivos`) para o formato do painel. A origem não é
alterada e nada que já existe no destino é sobrescrito.

```
python ferramentas/importar_evidencias.py "<pasta Evidências 2026>" "<pasta do painel>" 2026
```

Sem `--copiar`, o script só simula e mostra o relatório. Com `--copiar`, ele copia. O relatório lista:
- os arquivos sem código de qualificador, que ficam no indicador;
- os códigos antigos que não batem com a pasta (ex.: `II.10` dentro de `2.7`);
- as pastas ignoradas.

Os links dos arquivos `.txt` e `.url` vão para o `resposta.json`, no qualificador citado na linha.
Depois de importar, confira as marcações no painel.
- **Várias pessoas na mesma pasta:** cada pessoa pode salvar itens diferentes do mesmo indicador; o Salvar junta com o
  que já está na pasta. Se outra pessoa salvou o **mesmo item** depois que você abriu a página, a página avisa e não
  sobrescreve. Clique em **Descartar e recarregar** e refaça a alteração.

## Situação de cada indicador

Os itens de um indicador são cada qualificador marcado e a opção escolhida (ex.: 1.11). Indicador sem qualificador e
sem opção conta como preenchido quando tem anexo ou link. Indicador que o PDF diz não precisar de evidência
(ex.: 2.11, 4.1) mostra **Não exige evidência**.
O selo usa o que está **salvo**.

| Selo | Quando aparece |
|---|---|
| Pendente | Nenhum item marcado |
| Parcialmente preenchido 2/6 | Parte dos itens marcada (2 de 6) |
| Preenchido | Todos os itens marcados |
| Falta evidência: 1.5b | Selo extra: item marcado sem anexo nem link. Vale para o indicador e para os qualificadores que têm evidência própria no PDF. |
| Não salvo | Selo extra: há alteração na tela que ainda não foi salva |

## Novo ano: atualizar com o PDF da ABEP

O código não muda. Só entra um arquivo novo em `dados/`. O passo a passo e a estrutura do índice estão em
[ESTRUTURA-ABEP-TIC.md](ESTRUTURA-ABEP-TIC.md). Entregue o PDF novo à IA com este pedido:

> Leia o ESTRUTURA-ABEP-TIC.md e siga o roteiro da seção 8 com o PDF `<caminho do PDF>` para o ano `<AAAA>`.

O ano mais recente abre primeiro. Os anos anteriores continuam no seletor **Ano**.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `ESTRUTURA-ABEP-TIC.md` | Como o índice ABEP-TIC é organizado e como o PDF anual vira `dados/AAAA.js` (para a IA) |
| `abrir-painel.bat` | Abre o painel (dois cliques) |
| `servidor.py` | Servidor local: abre a página e lê/grava na pasta da rede; recusa sobrescrever ou apagar o log |
| `index.html` | Página |
| `app.js` | Tela; lê e grava pelo `servidor.py` |
| `estilo.css` | Visual, no padrão do Portal de BI da SETDIG (`bi-setdig`): tokens do DS-MS, Inter e Fira Mono |
| `img/logo-ms-horizontal.svg` | Logo do Governo de MS (copiado do `bi-setdig`) |
| `dados/AAAA.js` | Indicadores de cada ano, extraídos do PDF |
| `ferramentas/extrair_pdf.py` | Lê o PDF da ABEP e gera `dados/AAAA.js` |
