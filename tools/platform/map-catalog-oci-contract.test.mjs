import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repository = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, repository), "utf8");
}

function block(source, pattern, label) {
  const matched = source.match(pattern)?.[0];
  assert.ok(matched, `${label} must exist`);
  return matched;
}

test("map/catalog publication identity is a private, versioned OCI boundary", () => {
  const storage = read("infra/terraform/oci/always-free-a1-flex/datapack_object_storage.tf");
  const variables = read("infra/terraform/oci/always-free-a1-flex/variables.tf");
  const locals = read("infra/terraform/oci/always-free-a1-flex/locals.tf");
  const outputs = read("infra/terraform/oci/always-free-a1-flex/outputs.tf");
  const example = read("infra/terraform/oci/always-free-a1-flex/terraform.tfvars.example");

  const bucket = block(storage, /resource "oci_objectstorage_bucket" "map_catalog" \{[\s\S]*?\n\}/, "map/catalog bucket");
  assert.match(bucket, /access_type\s*=\s*"NoPublicAccess"/);
  assert.match(bucket, /versioning\s*=\s*"Enabled"/);
  assert.match(bucket, /name\s*=\s*var\.map_catalog_bucket_name/);
  assert.match(bucket, /namespace\s*=\s*data\.oci_objectstorage_namespace\.this\.namespace/);
  assert.doesNotMatch(storage, /oci_objectstorage_object_lifecycle_policy[\s\S]*map_catalog|map_catalog[\s\S]*oci_objectstorage_object_lifecycle_policy/);
  assert.doesNotMatch(storage, /oci_identity_customer_secret_key" "map_catalog/);

  for (const principal of ["publisher", "reader"]) {
    const user = block(storage, new RegExp(`resource "oci_identity_user" "map_catalog_${principal}" \\{[\\s\\S]*?\\n\\}`), `${principal} user`);
    const group = block(storage, new RegExp(`resource "oci_identity_group" "map_catalog_${principal}" \\{[\\s\\S]*?\\n\\}`), `${principal} group`);
    const membership = block(storage, new RegExp(`resource "oci_identity_user_group_membership" "map_catalog_${principal}" \\{[\\s\\S]*?\\n\\}`), `${principal} membership`);
    assert.match(user, /provider\s*=\s*oci\.identity_home/);
    assert.match(user, /compartment_id\s*=\s*var\.tenancy_ocid/);
    assert.match(group, /provider\s*=\s*oci\.identity_home/);
    assert.match(group, /compartment_id\s*=\s*var\.tenancy_ocid/);
    assert.match(membership, /provider\s*=\s*oci\.identity_home/);
    assert.match(membership, new RegExp(`group_id\\s*=\\s*oci_identity_group\\.map_catalog_${principal}\\.id`));
    assert.match(membership, new RegExp(`user_id\\s*=\\s*oci_identity_user\\.map_catalog_${principal}\\.id`));
  }

  const publisherPolicy = block(storage, /resource "oci_identity_policy" "map_catalog_publisher" \{[\s\S]*?\n\}/, "publisher policy");
  const readerPolicy = block(storage, /resource "oci_identity_policy" "map_catalog_reader" \{[\s\S]*?\n\}/, "reader policy");
  const mapCatalogBoundary = [bucket, publisherPolicy, readerPolicy].join("\n");
  assert.doesNotMatch(mapCatalogBoundary, /oci_(?:objectstorage_bucket|identity_(?:user|group|policy))\.(?:datapack|candidate)/);
  assert.doesNotMatch(mapCatalogBoundary, /var\.(?:datapack|candidate)[A-Za-z0-9_]*/);
  for (const policy of [publisherPolicy, readerPolicy]) {
    assert.match(policy, /provider\s*=\s*oci\.identity_home/);
    assert.match(policy, /compartment_id\s*=\s*var\.tenancy_ocid/);
    assert.match(policy, /target\.bucket\.name\s*=\s*'\$\{var\.map_catalog_bucket_name\}'/);
    assert.doesNotMatch(policy, /OBJECT_(?:INSPECT|DELETE|UPDATE|OVERWRITE)|manage buckets|manage object-family/i);
  }
  assert.match(publisherPolicy, /Allow group \$\{oci_identity_group\.map_catalog_publisher\.name\} to manage objects in compartment id \$\{var\.compartment_ocid\} where all \{target\.bucket\.name = '\$\{var\.map_catalog_bucket_name\}', any \{request\.permission = 'OBJECT_CREATE', request\.permission = 'OBJECT_READ'\}\}/);
  assert.match(readerPolicy, /Allow group \$\{oci_identity_group\.map_catalog_reader\.name\} to manage objects in compartment id \$\{var\.compartment_ocid\} where all \{target\.bucket\.name = '\$\{var\.map_catalog_bucket_name\}', request\.permission = 'OBJECT_READ'\}/);

  for (const [name, value] of [
    ["map_catalog_bucket_name", "easysubway-map-catalog"],
    ["map_catalog_object_prefix", "map-catalog"],
    ["map_catalog_publisher_access_key_secret_name", "OCI_MAP_CATALOG_PUBLISHER_ACCESS_KEY"],
    ["map_catalog_publisher_secret_key_secret_name", "OCI_MAP_CATALOG_PUBLISHER_SECRET_KEY"],
    ["map_catalog_reader_access_key_secret_name", "OCI_MAP_CATALOG_READER_ACCESS_KEY"],
    ["map_catalog_reader_secret_key_secret_name", "OCI_MAP_CATALOG_READER_SECRET_KEY"],
  ]) {
    const variable = block(variables, new RegExp(`variable "${name}" \\{[\\s\\S]*?\\n\\}`), `${name} variable`);
    assert.match(variable, new RegExp(`default\\s*=\\s*"${value}"`));
    assert.match(example, new RegExp(`^${name}\\s*=\\s*"${value}"$`, "m"));
  }

  assert.match(locals, /map_catalog_object_storage_endpoint\s*=\s*"https:\/\/\$\{data\.oci_objectstorage_namespace\.this\.namespace\}\.compat\.objectstorage\.\$\{var\.region\}\.oraclecloud\.com"/);
  for (const name of ["map_catalog_namespace", "map_catalog_bucket_name", "map_catalog_region", "map_catalog_object_storage_endpoint", "map_catalog_object_prefix", "github_actions_map_catalog_credential_secret_names"]) {
    assert.match(outputs, new RegExp(`output "${name}"`));
  }
  const secretNames = block(outputs, /output "github_actions_map_catalog_credential_secret_names" \{[\s\S]*?\n\}/, "map/catalog GitHub secret-name output");
  for (const variable of ["map_catalog_publisher_access_key_secret_name", "map_catalog_publisher_secret_key_secret_name", "map_catalog_reader_access_key_secret_name", "map_catalog_reader_secret_key_secret_name"]) assert.match(secretNames, new RegExp(`var\\.${variable}`));
  assert.doesNotMatch(secretNames, /secret_key\s*=\s*oci_|access_key\s*=\s*oci_/);
});

test("Platform CI runs the map/catalog OCI contract exactly once", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.equal((workflow.match(/^\s*node --test tools\/platform\/map-catalog-oci-contract\.test\.mjs$/gm) ?? []).length, 1);
});
