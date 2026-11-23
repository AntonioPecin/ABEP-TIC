"""Servidor local do painel ABEP-TIC.

Abre a página e lê/grava as evidências direto na pasta da rede, sem a pessoa precisar escolher a pasta.
Uso:  python servidor.py                 (pasta de "caminho_rede" no config.json)
      python servidor.py "C:\\outra\\pasta"  (outra pasta, por exemplo para teste)
Ao iniciar, confere se a pasta existe e se dá para ler e gravar nela; se não, avisa e não abre.
Só aceita conexões desta máquina (127.0.0.1). Só usa a biblioteca padrão do Python.

O log (log-evidencias.csv) só aceita acréscimo: o servidor recusa sobrescrever ou apagar esse arquivo.
"""
import json
import os
import sys
import tempfile
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

LOG = "log-evidencias.csv"
RESPOSTA = "resposta.json"
BACKUP = "_backup"  # <ano>/_backup: toda evidência removida ou substituída; o painel não altera nem apaga nada aqui
PORTA = 8765
PAGINA = Path(__file__).resolve().parent
CONFIG = PAGINA / "config.json"


def caminho_configurado():
    """Lê "caminho_rede" do config.json, ao lado deste arquivo."""
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))["caminho_rede"]
    except (OSError, ValueError, KeyError) as e:
        sys.exit(f"Não consegui ler \"caminho_rede\" em {CONFIG}: {e}")


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

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(PAGINA), **k)

    def log_message(self, *a):  # silencioso
        pass

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

    def api(self, metodo):
        rota = urlparse(self.path).path
        try:
            if rota == "/api/info":
                return self.responder(200, {"pasta": str(self.raiz), "nome": self.raiz.name})
            alvo = self.caminho()
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
            if rota == "/api/acrescentar" and metodo == "POST":  # só acrescenta no fim
                with open(alvo, "ab") as f:
                    self.corpo_para(f)
                return self.responder(200, {})
            return self.responder(404, {"erro": "rota desconhecida"})
        except PermissionError as e:
            return self.responder(403, {"erro": str(e)})
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
    raiz = Path(args[0] if args else caminho_configurado())
    problema = conferir_acesso(raiz)
    if problema:
        sys.exit(f"Erro: {raiz}: {problema}. Confira a conexão com a rede ou peça acesso à TI.")
    Painel.raiz = raiz.resolve()
    for porta in range(PORTA, PORTA + 20):  # porta ocupada (outro painel aberto): tenta a seguinte
        try:
            servidor = Servidor(("127.0.0.1", porta), Painel)
            break
        except OSError:
            continue
    else:
        sys.exit("Nenhuma porta livre entre 8765 e 8784.")
    url = f"http://127.0.0.1:{porta}/"  # não "localhost": pode cair em outro servidor que ouve em IPv6
    print(f"Painel ABEP-TIC em {url}\nEvidências em {raiz}\nPara fechar, feche esta janela.", flush=True)
    if "--sem-navegador" not in sys.argv:
        webbrowser.open(url)
    servidor.serve_forever()


if __name__ == "__main__":
    main()
