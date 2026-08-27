FROM python:3.11-slim

# Unbuffered stdout so `docker logs` shows the audit trail in real time
# rather than only on buffer flush/exit — this watcher's whole point is
# transparency into what it checks/does against a real human session.
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ /app/app/

RUN useradd --uid 1000 --create-home watcher
USER watcher

CMD ["python3", "-m", "app.main"]
