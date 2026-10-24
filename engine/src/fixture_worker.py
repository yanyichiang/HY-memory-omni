"""Test packaging of production /compute; only model HTTP is synthetic."""
import main
from fixture_models import Models, config as fixture_model_config

# Each request receives its own model script, built from the real TS source
# envelope. This fixture must not invent unrelated facts or share response
# positions between concurrent sessions. Search still runs production Reader.
_compute = main.compute


async def fixture_compute(body, *, config=None, read_transport=None):
    if body.get('operation') == 'write':
        ref = body['sourceRef']
        perception = body['perception']
        owner = perception['model'] in ('owner-statement', 'owner-correction')
        attribution = 'Owner evidence' if owner else 'Fallible machine observation'
        content = (f"{attribution}; sourceId={ref['sourceId']}; "
                   f"revision={ref['revision']}; kind={perception['kind']}: "
                   f"{body['content']}")
        models = Models([{'memory': [{'content': content,
                                     'tags': ['source-evidence'],
                                     'owner': 'user' if owner else 'agent'}],
                          'basic_info': {}}],
                        allow_owner_statement=(perception['kind'] == 'text' and
                                               perception['model'] == 'owner-statement'))
    else:
        models = Models()
    return await _compute(body, config=fixture_model_config(models), read_transport=read_transport)


main.compute = fixture_compute
main.model_config = lambda _values: fixture_model_config(Models())
Default = main.Default
