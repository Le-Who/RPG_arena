CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
-- Keep real[] storage compatible with existing application/worker versions.
-- Invalid legacy values must not abort an otherwise valid campaign search.
CREATE FUNCTION chronicle_memory_vector(input_values real[], expected_dims integer)
RETURNS vector LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE converted vector;
BEGIN
  IF array_ndims(input_values) <> 1 OR cardinality(input_values) <> expected_dims THEN RETURN NULL; END IF;
  converted := input_values::vector;
  IF vector_norm(converted) = 0 THEN RETURN NULL; END IF;
  RETURN converted;
EXCEPTION WHEN data_exception THEN RETURN NULL;
END;
$$;
--> statement-breakpoint
-- formatDocument uses JS slice(0, 6000), which counts UTF-16 code units.
-- A split surrogate is encoded by Node's hash input as the replacement character.
CREATE FUNCTION chronicle_embedding_hash(model text, dims integer, title text, content text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE document text := 'title: ' || coalesce(nullif(title, ''), 'none') || ' | text: ' || content;
        clipped text := ''; ch text; units integer := 0; width integer;
BEGIN
  IF length(document) > 3000 THEN
    FOR i IN 1..least(length(document), 6000) LOOP
      ch := substr(document, i, 1);
      width := CASE WHEN ascii(ch) > 65535 THEN 2 ELSE 1 END;
      IF units + width > 6000 THEN
        IF units < 6000 THEN clipped := clipped || chr(65533); END IF;
        EXIT;
      END IF;
      clipped := clipped || ch;
      units := units + width;
      EXIT WHEN units = 6000;
    END LOOP;
    document := clipped;
  END IF;
  RETURN left(encode(digest(convert_to(model || chr(9247) || dims::text || chr(9247) || document, 'UTF8'), 'sha1'), 'hex'), 32);
END;
$$;
