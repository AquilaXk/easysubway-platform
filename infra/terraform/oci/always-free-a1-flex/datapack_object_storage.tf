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

resource "oci_identity_customer_secret_key" "datapack_publisher" {
  provider = oci.identity_home

  display_name = "${var.name_prefix}-datapack-publisher"
  user_id      = var.user_ocid
}

resource "oci_objectstorage_bucket" "map_catalog" {
  access_type    = "NoPublicAccess"
  compartment_id = var.compartment_ocid
  freeform_tags  = local.common_tags
  name           = var.map_catalog_bucket_name
  namespace      = data.oci_objectstorage_namespace.this.namespace
  storage_tier   = "Standard"
  versioning     = "Enabled"
}

resource "oci_identity_user" "map_catalog_publisher" {
  provider = oci.identity_home

  compartment_id = var.tenancy_ocid
  description    = "Publishes signed-current map and catalog objects only."
  name           = "${var.name_prefix}-map-catalog-publisher"
}

resource "oci_identity_group" "map_catalog_publisher" {
  provider = oci.identity_home

  compartment_id = var.tenancy_ocid
  description    = "Map/catalog signed-current publisher group."
  name           = "${var.name_prefix}-map-catalog-publisher"
}

resource "oci_identity_user_group_membership" "map_catalog_publisher" {
  provider = oci.identity_home

  group_id = oci_identity_group.map_catalog_publisher.id
  user_id  = oci_identity_user.map_catalog_publisher.id
}

resource "oci_identity_policy" "map_catalog_publisher" {
  provider = oci.identity_home

  compartment_id = var.tenancy_ocid
  description    = "Map/catalog publisher may create and read objects in its dedicated bucket only."
  name           = "${var.name_prefix}-map-catalog-publisher"
  statements = [
    "Allow group ${oci_identity_group.map_catalog_publisher.name} to manage objects in compartment id ${var.compartment_ocid} where all {target.bucket.name = '${var.map_catalog_bucket_name}', any {request.permission = 'OBJECT_CREATE', request.permission = 'OBJECT_READ'}}",
  ]
}

resource "oci_identity_user" "map_catalog_reader" {
  provider = oci.identity_home

  compartment_id = var.tenancy_ocid
  description    = "Reads signed-current map and catalog objects only."
  name           = "${var.name_prefix}-map-catalog-reader"
}

resource "oci_identity_group" "map_catalog_reader" {
  provider = oci.identity_home

  compartment_id = var.tenancy_ocid
  description    = "Map/catalog signed-current reader group."
  name           = "${var.name_prefix}-map-catalog-reader"
}

resource "oci_identity_user_group_membership" "map_catalog_reader" {
  provider = oci.identity_home

  group_id = oci_identity_group.map_catalog_reader.id
  user_id  = oci_identity_user.map_catalog_reader.id
}

resource "oci_identity_policy" "map_catalog_reader" {
  provider = oci.identity_home

  compartment_id = var.tenancy_ocid
  description    = "Map/catalog reader may read objects in its dedicated bucket only."
  name           = "${var.name_prefix}-map-catalog-reader"
  statements = [
    "Allow group ${oci_identity_group.map_catalog_reader.name} to manage objects in compartment id ${var.compartment_ocid} where all {target.bucket.name = '${var.map_catalog_bucket_name}', request.permission = 'OBJECT_READ'}",
  ]
}
