"""Servidor local do painel ABEP-TIC.

Abre a página e lê/grava as evidências direto na pasta da rede, sem a pessoa precisar escolher a pasta.
Uso:  python servidor.py                 (pasta de "caminho_rede" no config.json)
      python servidor.py "C:\\outra\\pasta"  (outra pasta, por exemplo para teste)
Ao iniciar, confere se a pasta existe e se dá para ler e gravar nela; se não, avisa e não abre.
Só aceita conexões desta máquina (127.0.0.1). Só usa a biblioteca padrão do Python.

O log (log-evidencias.csv) só aceita acréscimo: o servidor recusa sobrescrever ou apagar esse arquivo. Cada
acréscimo é feito sob trava (arquivo .lock na própria pasta da rede, porque cada pessoa roda o seu servidor.py) e só
entra se ainda encadeia com a última linha do log; se não, responde 409 e o painel refaz o encadeamento.
Só atende pedidos da própria página (Host/Origin 127.0.0.1 ou localhost na porta do painel).
Opções: --sem-navegador (não abre o navegador), --porta=N (usa só essa porta).
"""
import json
import os
import random
import sys
import tempfile
import time
import webbrowser
from contextlib import contextmanager
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

LOG = "log-evidencias.csv"
CABECALHO_LOG = "data_hora;colaborador;acao;indicador;qualificador;evidencia;hash_anterior;hash"
HASH_INICIAL = "0" * 64
TRAVA_ESPERA = 5   # segundos tentando pegar a trava do log antes de desistir (503)
TRAVA_VELHA = 30   # trava mais velha que isso foi abandonada (servidor fechado no meio) e é removida
RESPOSTA = "resposta.json"
BACKUP = "_backup"  # <ano>/_backup: toda evidência removida ou substituída; o painel não altera nem apaga nada aqui
PORTA = 8765
PAGINA = Path(__file__).resolve().parent
CONFIG = PAGINA / "config.json"


def ler_config():
    """Lê o config.json, ao lado deste arquivo. "caminho_rede" é obrigatório."""
    try:
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
        config["caminho_rede"]
        return config
    except (OSError, ValueError, KeyError) as e:
        sys.exit(f"Não consegui ler \"caminho_rede\" em {CONFIG}: {e}")


def estado_da_pasta(pasta):
    """{caminho relativo: data de modificação} de todos os arquivos do ano, fora o _backup.
    A página compara duas leituras para saber o que entrou, saiu ou mudou."""
    estado = {}
    for dirpath, dirnames, arquivos in os.walk(pasta):
        dirnames[:] = [d for d in dirnames if d != BACKUP]
        for nome in arquivos:
            if nome.startswith(".tmp-") or nome.endswith(".lock"):
                continue
            caminho = Path(dirpath) / nome
            try:
                # microssegundos: cabe inteiro no número do JavaScript (nanossegundos não cabe)
                estado[caminho.relative_to(pasta).as_posix()] = caminho.stat().st_mtime_ns // 1000
            except OSError:  # apagado no meio da leitura
                pass
    return estado


def ultimo_hash(log):
    """Hash da última linha do log (última coluna). Log que não existe ou só tem cabeçalho: HASH_INICIAL.
    Lê só o fim do arquivo: o log cresce o ano todo."""
    if not log.is_file():
        return HASH_INICIAL
    with open(log, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - 8192))
        fim = f.read().decode("utf-8", "replace")
    linhas = [l for l in fim.splitlines() if l.strip()]
    if not linhas or linhas[-1].lstrip("﻿").startswith("data_hora;"):
        return HASH_INICIAL
    return linhas[-1].rsplit(";", 1)[-1].strip().strip('"')


@contextmanager
def trava(caminho):
    """Trava entre pessoas: criar o arquivo com O_EXCL só dá certo para um de cada vez, também na pasta da rede."""
    limite = time.monotonic() + TRAVA_ESPERA
    while True:
        try:
            os.close(os.open(caminho, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            try:
                if time.time() - caminho.stat().st_mtime > TRAVA_VELHA:
                    caminho.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue  # a outra pessoa acabou de soltar
            if time.monotonic() > limite:
                raise TimeoutError("o log está ocupado por outra pessoa; tente salvar de novo")
            time.sleep(0.05 + random.random() * 0.15)
    try:
        yield
    finally:
        caminho.unlink(missing_ok=True)


def conferir_acesso(pasta):
    """Pasta existe, dá para listar e dá para gravar? Grava e apaga um arquivo de teste
    (os.access não enxerga as permissões de pasta de rede do Windows)."""
    if not pasta.is_dir():
        return "a pasta não existe ou a rede não está conectada"
    try:
        next(pasta.iterdir(), None)
    except OSError:
        return "você não tem permissão para ler a pasta"
    try:
        fd, teste = tempfile.mkstemp(dir=pasta, prefix=".teste-acesso-")
        os.close(fd)
        os.remove(teste)
    except OSError:
        return "você não tem permissão para gravar na pasta"
    return ""


class Servidor(ThreadingHTTPServer):
    allow_reuse_address = False  # no Windows, True deixa abrir na porta de outro servidor sem erro


class Painel(SimpleHTTPRequestHandler):
    raiz: Path = None
    intervalo = 30  # segundos entre as conferências automáticas da pasta (config.json: "intervalo_segundos")

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(PAGINA), **k)

    def log_message(self, *a):  # silencioso
        pass

    def end_headers(self):
        # página, app.js e estilo.css: o navegador confere a versão a cada abertura (304 se não mudou), senão
        # continua mostrando o painel antigo depois de uma atualização
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---------- utilidades ----------
    def caminho(self):
        """Caminho pedido em ?p=, sempre dentro da raiz (bloqueia ../)."""
        rel = parse_qs(urlparse(self.path).query).get("p", [""])[0]
        alvo = (self.raiz / rel).resolve()
        if alvo != self.raiz and self.raiz not in alvo.parents:
            raise PermissionError("caminho fora da pasta das evidências")
        return alvo

    def responder(self, codigo, corpo=b"", tipo="application/json", extra=None):
        if isinstance(corpo, (dict, list)):
            corpo = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(corpo)

    def corpo_para(self, destino):
        """Copia o corpo da requisição para o arquivo aberto, em blocos (vídeos grandes)."""
        falta = int(self.headers.get("Content-Length", 0))
        while falta:
            bloco = self.rfile.read(min(falta, 1 << 20))
            if not bloco:
                break
            destino.write(bloco)
            falta -= len(bloco)

    def para_backup(self, alvo):
        """Move a evidência para <ano>/_backup/<mesmo caminho>/<data-hora> <nome>. Nada é apagado de vez."""
        rel = alvo.relative_to(self.raiz)
        carimbo = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        pasta = self.raiz / rel.parts[0] / BACKUP / Path(*rel.parts[1:-1])
        destino, n = pasta / f"{carimbo} {alvo.name}", 1
        while destino.exists():  # mesmo nome no mesmo segundo: não sobrescreve o backup anterior
            n += 1
            destino = pasta / f"{carimbo} ({n}) {alvo.name}"
        pasta.mkdir(parents=True, exist_ok=True)
        os.replace(alvo, destino)

    def de_fora(self):
        """Pedido que não veio da própria página do painel: outro site aberto no navegador (Origin) ou um nome de
        servidor estranho (Host, protege de DNS rebinding)."""
        porta = self.server.server_address[1]
        hosts = {f"127.0.0.1:{porta}", f"localhost:{porta}"}
        origem = self.headers.get("Origin")
        return self.headers.get("Host") not in hosts or (origem is not None and origem not in {f"http://{h}" for h in hosts})

    def api(self, metodo):
        rota = urlparse(self.path).path
        if self.de_fora():
            return self.responder(403, {"erro": "pedido de fora do painel"})
        try:
            if rota == "/api/info":
                return self.responder(200, {"pasta": str(self.raiz), "nome": self.raiz.name, "intervalo": self.intervalo})
            alvo = self.caminho()
            if rota == "/api/estado" and metodo == "GET":
                return self.responder(200, estado_da_pasta(alvo) if alvo.is_dir() else {})
            if BACKUP in alvo.relative_to(self.raiz).parts and metodo != "GET":
                return self.responder(403, {"erro": "a pasta de backup não pode ser alterada"})
            if rota == "/api/lista" and metodo == "GET":
                if not alvo.is_dir():
                    return self.responder(404, {"erro": "não existe"})
                return self.responder(200, [{"nome": p.name, "tipo": "directory" if p.is_dir() else "file"} for p in alvo.iterdir()])
            if rota == "/api/pasta" and metodo == "POST":
                alvo.mkdir(parents=True, exist_ok=True)
                return self.responder(200, {})
            if rota == "/api/arquivo":
                if metodo == "GET":
                    if not alvo.is_file():
                        return self.responder(404, {"erro": "não existe"})
                    return self.responder(200, alvo.read_bytes(), "application/octet-stream",
                                          {"X-Modificado": str(int(alvo.stat().st_mtime * 1000))})
                if alvo.name == LOG and metodo in ("PUT", "DELETE"):
                    return self.responder(403, {"erro": "o log só aceita acréscimo"})
                if metodo == "PUT":  # grava inteiro: escreve num temporário e troca (não deixa arquivo pela metade)
                    fd, tmp = tempfile.mkstemp(dir=alvo.parent, prefix=".tmp-")
                    with os.fdopen(fd, "wb") as f:
                        self.corpo_para(f)
                    if alvo.is_file() and alvo.name != RESPOSTA:
                        self.para_backup(alvo)  # evidência substituída: a versão antiga vai para o backup
                    os.replace(tmp, alvo)
                    return self.responder(200, {})
                if metodo == "DELETE":  # nunca apaga: move para o backup
                    self.para_backup(alvo)
                    return self.responder(200, {})
            if rota == "/api/acrescentar" and metodo == "POST":  # só acrescenta no fim, e só no log
                if alvo.name != LOG:
                    return self.responder(403, {"erro": "só o log aceita acréscimo"})
                corpo = self.rfile.read(int(self.headers.get("Content-Length", 0)))  # linhas do log: pequeno
                esperado = self.headers.get("X-Hash-Anterior", "")
                with trava(alvo.with_name(LOG + ".lock")):
                    if ultimo_hash(alvo) != esperado:
                        return self.responder(409, {"erro": "o log mudou desde a leitura; encadeie de novo"})
                    novo = not alvo.is_file() or alvo.stat().st_size == 0
                    with open(alvo, "ab") as f:
                        if novo:  # BOM + cabeçalho: o Excel abre com acentos e colunas certas
                            f.write(("﻿" + CABECALHO_LOG + "\r\n").encode("utf-8"))
                        f.write(corpo)
                return self.responder(200, {})
            return self.responder(404, {"erro": "rota desconhecida"})
        except PermissionError as e:
            return self.responder(403, {"erro": str(e)})
        except TimeoutError as e:
            return self.responder(503, {"erro": str(e)})
        except FileNotFoundError:
            return self.responder(404, {"erro": "não existe"})
        except OSError as e:
            return self.responder(500, {"erro": str(e)})

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.api("GET")
        return super().do_GET()

    def do_POST(self):
        return self.api("POST")

    def do_PUT(self):
        return self.api("PUT")

    def do_DELETE(self):
        return self.api("DELETE")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    config = ler_config()
    raiz = Path(args[0] if args else config["caminho_rede"])
    Painel.intervalo = max(5, int(config.get("intervalo_segundos", 30)))
    problema = conferir_acesso(raiz)
    if problema:
        sys.exit(f"Erro: {raiz}: {problema}. Confira a conexão com a rede ou peça acesso à TI.")
    Painel.raiz = raiz.resolve()
    fixa = next((int(a.split("=", 1)[1]) for a in sys.argv if a.startswith("--porta=")), None)
    portas = [fixa] if fixa else range(PORTA, PORTA + 20)  # porta ocupada (outro painel aberto): tenta a seguinte
    for porta in portas:
        try:
            servidor = Servidor(("127.0.0.1", porta), Painel)
            break
        except OSError:
            continue
    else:
        sys.exit(f"Porta ocupada: {fixa}." if fixa else "Nenhuma porta livre entre 8765 e 8784.")
    url = f"http://127.0.0.1:{porta}/"  # não "localhost": pode cair em outro servidor que ouve em IPv6
    print(f"Painel ABEP-TIC em {url}\nEvidências em {raiz}\nPara fechar, feche esta janela.", flush=True)
    if "--sem-navegador" not in sys.argv:
        webbrowser.open(url)
    servidor.serve_forever()


if __name__ == "__main__":
    main()
