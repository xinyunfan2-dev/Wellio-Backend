FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml requirements.txt ./
COPY wellio ./wellio
RUN pip install --no-cache-dir --require-hashes -r requirements.txt && pip install --no-cache-dir --no-deps . && useradd --create-home --uid 10001 wellio && mkdir /data && chown wellio:wellio /data
USER wellio
ENV WELLIO_ATTACHMENTS_PATH=/data/attachments
EXPOSE 8000
CMD ["uvicorn", "wellio.main:application", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
