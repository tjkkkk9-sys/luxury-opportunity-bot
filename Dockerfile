FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY examples ./examples
RUN pip install --no-cache-dir .

EXPOSE 8000
CMD ["uvicorn", "luxury_opportunity_bot.web:app", "--host", "0.0.0.0", "--port", "8000"]
