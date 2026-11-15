FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py multiplayer.py engine.py database.py Chess.html ./
ENV PORT=3000 DB_PATH=/tmp/chess.db TRUST_PROXY=1 PYTHONUNBUFFERED=1
RUN useradd --create-home app && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import os,urllib.request as u;u.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/api/health',timeout=4)"
CMD ["python","server.py"]
