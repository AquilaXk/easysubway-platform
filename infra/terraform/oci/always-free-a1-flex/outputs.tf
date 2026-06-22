output "instance_id" {
  description = "Created OCI compute instance OCID."
  value       = oci_core_instance.this.id
}

output "instance_public_ip" {
  description = "Public IPv4 address assigned to the instance VNIC."
  value       = oci_core_instance.this.public_ip
}

output "instance_private_ip" {
  description = "Private IPv4 address assigned to the instance VNIC."
  value       = oci_core_instance.this.private_ip
}

output "data_volume_id" {
  description = "Data Block Volume OCID. Null when create_data_volume is false."
  value       = var.create_data_volume ? oci_core_volume.data[0].id : null
}

output "data_volume_attachment_id" {
  description = "Data Block Volume attachment OCID. Null when create_data_volume is false."
  value       = var.create_data_volume ? oci_core_volume_attachment.data[0].id : null
}

output "data_volume_mount_path" {
  description = "Guest OS mount path for the data volume."
  value       = var.create_data_volume ? var.data_volume_mount_path : null
}

output "vcn_id" {
  description = "Created VCN OCID."
  value       = oci_core_vcn.this.id
}

output "subnet_id" {
  description = "Created public subnet OCID."
  value       = oci_core_subnet.public.id
}

output "selected_image_id" {
  description = "Image OCID used to launch the instance."
  value       = local.selected_image_id
}

output "selected_image_display_name" {
  description = "Display name of the automatically selected image, or source_image_ocid_override when pinned."
  value       = local.selected_image_display_name
}

output "selected_image_time_created" {
  description = "Creation time of the automatically selected image. Null when source_image_ocid_override is used."
  value       = local.selected_image_time_created
}

output "datapack_bucket_name" {
  description = "Object Storage bucket used for app data pack publication."
  value       = oci_objectstorage_bucket.datapack.name
}

output "datapack_namespace" {
  description = "OCI Object Storage namespace for the data pack bucket."
  value       = data.oci_objectstorage_namespace.this.namespace
}

output "datapack_public_base_url" {
  description = "Public HTTPS base URL for EASYSUBWAY_DATA_PACK_BASE_URL."
  value       = local.datapack_base_url
}

output "datapack_oci_public_base_url" {
  description = "OCI-native public HTTPS base URL. Use this when no custom domain is configured."
  value       = local.datapack_oci_base_url
}

output "datapack_object_storage_endpoint" {
  description = "S3-compatible endpoint for EASYSUBWAY_OBJECT_STORAGE_ENDPOINT."
  value       = local.datapack_object_storage_endpoint
}

output "datapack_object_prefix" {
  description = "Object prefix expected by EASYSUBWAY_DATA_PACK_BASE_URL."
  value       = var.datapack_object_prefix
}

output "github_actions_datapack_env" {
  description = "Non-secret GitHub Actions values for data pack publishing. Access key and secret key must stay in GitHub secrets."
  value = {
    EASYSUBWAY_DATA_PACK_BASE_URL      = local.datapack_base_url
    EASYSUBWAY_DATAPACK_BUCKET         = oci_objectstorage_bucket.datapack.name
    EASYSUBWAY_OBJECT_STORAGE_ENDPOINT = local.datapack_object_storage_endpoint
    EASYSUBWAY_OBJECT_STORAGE_REGION   = var.region
  }
}

output "recommended_dns_records" {
  description = "Cloudflare records to create outside Terraform. Do not point datapack_domain_name at clients until path rewrite or proxying is configured."
  value = {
    server = {
      name  = var.server_domain_name
      type  = "A"
      value = oci_core_instance.this.public_ip
    }
    datapack_reserved = {
      name                      = var.datapack_domain_name
      custom_base_url_candidate = "https://${var.datapack_domain_name}/${var.datapack_object_prefix}"
      current_base_url          = local.datapack_base_url
      note                      = "Use current_base_url until a reverse proxy or CDN rewrites this host to the OCI Object Storage bucket prefix."
    }
  }
}
