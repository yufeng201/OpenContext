import type Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

let engine: Promise<Ajv> | undefined;
const validators = new WeakMap<object, ValidateFunction>();

export async function validateForm<T extends FieldValues>(
  schema: object,
  values: T,
  setError: UseFormSetError<T>,
) {
  let validate = validators.get(schema);
  if (!validate) {
    engine ??= import('ajv').then(
      ({ default: Ajv }) => new Ajv({ allErrors: true, strict: true }),
    );
    const ajv = await engine;
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  if (validate(values)) return true;
  for (const error of validate.errors ?? []) {
    const key =
      error.instancePath.split('/')[1] ??
      String(error.params['missingProperty'] ?? 'root');
    setError(key as Path<T>, {
      type: 'schema',
      message: '请检查此字段的内容与长度。',
    });
  }
  return false;
}
