data "oci_objectstorage_namespace" "this" {
  compartment_id = var.compartment_ocid
}

resource "oci_objectstorage_bucket" "datapack" {
  access_type    = var.datapack_bucket_public_access_type
  compartment_id = var.compartment_ocid
  freeform_tags  = local.common_tags
  name           = var.datapack_bucket_name
  namespace      = data.oci_objectstorage_namespace.this.namespace
  storage_tier   = "Standard"
  versioning     = "Enabled"
}
