"""Build the MCP catalog from the published InSales REST documentation."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import parse_qsl
from urllib.request import urlopen

from bs4 import BeautifulSoup

SOURCE = 'https://api.insales.ru/'
OUTPUT = Path(__file__).resolve().parents[1] / 'src/features/public-api/catalog.json'


def catalog(html):
    soup = BeautifulSoup(html, 'html.parser')
    operations = {}
    for heading in soup.find_all('h3', string='Endpoint'):
        method, route = heading.find_next('pre').get_text(strip=True).split(' ', 1)
        path, _, query = ('/' + route.lstrip('/')).partition('?')
        if not re.fullmatch(r'/admin/[a-zA-Z0-9_/:.-]+\.json', path):
            raise ValueError(f'Unexpected published route: {route}')
        resource = heading.find_previous('h1').get_text(strip=True)
        title = heading.find_previous('h2').get_text(strip=True)
        key = method, path
        slug = re.sub(r'[^a-z0-9]+', '_', path.removeprefix('/admin/').removesuffix('.json').lower())
        operation = operations.setdefault(key, {
            'name': f'api_{method.lower()}_{slug}',
            'resource': resource,
            'method': method,
            'path': path,
            'variants': [],
        })
        variant = {'title': title}
        if query:
            variant['query'] = dict(parse_qsl(query))
        for section in heading.find_all_next(['h2', 'h3', 'h4']):
            label = section.get_text(strip=True)
            if section.name == 'h2' or label == 'Response':
                break
            if label == 'Parameters':
                table = section.find_next('table')
                if table:
                    variant['parameters'] = [
                        [cell.get_text(' ', strip=True) for cell in row.find_all('td')]
                        for row in table.find_all('tr') if row.find_all('td')
                    ]
            if label == 'Body':
                body = json.loads(section.find_next('pre').get_text(strip=True).strip('`'))
                variant['body_fields'] = describe_fields(body)
        operation['variants'].append(variant)
    if len(operations) < 250 or len({op['name'] for op in operations.values()}) != len(operations):
        raise ValueError('Incomplete catalog or duplicate operation names')
    return list(operations.values())


def describe_fields(value):
    if isinstance(value, dict):
        return {key: describe_fields(field) for key, field in value.items()}
    if isinstance(value, list):
        variants = []
        for item in value:
            shape = describe_fields(item)
            if shape not in variants:
                variants.append(shape)
        return variants
    return type(value).__name__


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--html', type=Path)
    args = parser.parse_args()
    if args.html:
        html = args.html.read_bytes()
    else:
        with urlopen(SOURCE, timeout=30) as response:
            html = response.read()
    operations = catalog(html)
    content = json.dumps(operations, ensure_ascii=False, indent=2) + '\n'
    if args.check:
        if OUTPUT.read_text() != content:
            raise SystemExit('Public catalog differs from the documentation.')
    else:
        OUTPUT.write_text(content)
    print(f'{len(operations)} operations, {sum(len(o["variants"]) for o in operations)} documented variants')


if __name__ == '__main__':
    main()
