provider "oci" {
  auth                = "APIKey"
  config_file_profile = var.config_file_profile
  region              = var.region
}
