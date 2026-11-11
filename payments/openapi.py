"""Pinned official REST contract, not a reconstructed MCP tool schema."""
import copy
import hashlib
import json
from pathlib import Path
from .model import PaymentError, Unsupported
from .schema import check_schema, validate

OPENAPI_SHA256 = '2c7b2496e05f56aece8b13f8a825845a54b8cae9689efd4f3acf79ea28e32cd3'


class OfficialContract:
    def __init__(self):
        raw = (Path(__file__).parent / 'official/openapi.json').read_bytes()
        if hashlib.sha256(raw).hexdigest() != OPENAPI_SHA256:
            raise Unsupported('official OpenAPI pin mismatch; review before updating')
        self.document = json.loads(raw)
        self.operations = {}
        for path, methods in self.document['paths'].items():
            for method, operation in methods.items():
                if isinstance(operation, dict) and 'operationId' in operation:
                    self.operations[operation['operationId']] = (method.upper(), path, operation)

    def schema(self, value, seen=()):
        """Inline local refs; normalize only OpenAPI annotations/numeric formats.

        Unsupported assertions still fail in check_schema; no permissive fallback.
        """
        if isinstance(value, bool):
            return value
        node = copy.deepcopy(value)
        if '$ref' in node:
            ref = node.pop('$ref')
            if not ref.startswith('#/components/schemas/') or ref in seen:
                raise Unsupported('unsupported OpenAPI reference')
            name = ref.rsplit('/', 1)[-1]
            target = self.schema(self.document['components']['schemas'][name], seen + (ref,))
            return self.schema({'allOf': [target, node]}, seen) if node else target
        node.pop('example', None)  # OpenAPI annotation, never a constraint
        fmt = node.get('format')
        if fmt in ('int32', 'int64'):
            bits = int(fmt[3:])
            node.pop('format')
            node['minimum'] = max(node.get('minimum', -(2**(bits-1))), -(2**(bits-1)))
            node['maximum'] = min(node.get('maximum', 2**(bits-1)-1), 2**(bits-1)-1)
        elif fmt == 'double':
            node.pop('format')  # finite JSON numbers enforced by validator
        for key in ('properties', '$defs', 'definitions'):
            if key in node:
                node[key] = {k: self.schema(v, seen) for k, v in node[key].items()}
        for key in ('allOf', 'anyOf', 'oneOf'):
            if key in node:
                node[key] = [self.schema(v, seen) for v in node[key]]
        for key in ('items', 'additionalProperties'):
            if key in node:
                node[key] = self.schema(node[key], seen)
        check_schema(node)
        return node

    def named(self, name, value):
        validate(value, self.schema({'$ref': '#/components/schemas/' + name}))
        return value

    def request(self, operation_id, path=None, query=None, body=None):
        method, template, operation = self.operations[operation_id]
        path, query = dict(path or {}), dict(query or {})
        allowed = {'path': {}, 'query': {}}
        for parameter in operation.get('parameters', []):
            place = parameter['in']
            if place not in allowed:
                raise Unsupported('unsupported OpenAPI parameter location')
            allowed[place][parameter['name']] = parameter
        for place, values in (('path', path), ('query', query)):
            if set(values) - set(allowed[place]):
                raise PaymentError('unknown request parameter')
            for name, parameter in allowed[place].items():
                if parameter.get('required') and name not in values:
                    raise PaymentError('missing request parameter')
                if name in values:
                    validate(values[name], self.schema(parameter['schema']))
            for name in ('offset', 'limit'):
                if name in values and (type(values[name]) is not int or values[name] < (1 if name == 'limit' else 0)):
                    raise PaymentError('invalid pagination')
        if body is not None:
            try:
                schema = operation['requestBody']['content']['application/json']['schema']
            except KeyError:
                raise Unsupported('no JSON request body in official schema') from None
            validate(body, self.schema(schema))
        elif operation.get('requestBody', {}).get('required'):
            raise PaymentError('required request body missing')
        from urllib.parse import quote, urlencode
        for name, value in path.items():
            template = template.replace('{' + name + '}', quote(value, safe=''))
        encoded = {k: ('true' if v else 'false') if type(v) is bool else v for k, v in query.items()}
        return method, template + ('?' + urlencode(encoded) if encoded else '')

    def response(self, operation_id, status, value):
        operation = self.operations[operation_id][2]
        try:
            schema = operation['responses'][str(status)]['content']['application/json']['schema']
        except KeyError:
            raise Unsupported('undocumented JSON response status or content') from None
        validate(value, self.schema(schema))
        return value
