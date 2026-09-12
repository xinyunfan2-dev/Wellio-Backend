import os
from .app import create_app
from .search import ExaSearchService


def application():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise RuntimeError('DATABASE_URL_REQUIRED: configure a PostgreSQL connection URL')
    return create_app(
        database_url=database_url,
        search_service=ExaSearchService(api_key=os.environ.get('EXA_API_KEY', '')),
        attachments_path=os.environ.get('WELLIO_ATTACHMENTS_PATH') or None,
        public_origins=tuple(filter(None, os.environ.get('WELLIO_PUBLIC_ORIGIN', '').split(','))),
        cookie_secure=None if 'WELLIO_COOKIE_SECURE' not in os.environ else os.environ['WELLIO_COOKIE_SECURE'] == '1',
    )
