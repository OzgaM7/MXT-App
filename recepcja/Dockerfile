# MXT Recepcja AI – serwer asystentki dla Twilio (server.py). Budowanie: docker build -t mxt-recepcja recepcja/
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
# Baza SQLite (rezerwacje w kalendarzu lokalnym, kolejka rozmów do aplikacji MXT). Na Render: dysk podpięty pod /data.
ENV BAZA_SQLITE=/data/recepcja.db
RUN mkdir -p /data
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
