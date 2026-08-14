terraform {
  required_version = ">= 1.6.0"

  backend "local" {}

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.8"
    }
  }
}
