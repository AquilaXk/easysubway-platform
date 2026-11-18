variable "region" {
  description = "OCI region that contains the existing data volume."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.region))
    error_message = "region must be a canonical OCI region identifier."
  }
}

variable "config_file_profile" {
  description = "Profile in the existing OCI CLI configuration file."
  type        = string
  default     = "DEFAULT"
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.config_file_profile))
    error_message = "config_file_profile must contain only letters, digits, dot, underscore, or hyphen."
  }
}

variable "compartment_ocid" {
  description = "Compartment that owns the backup policy, event rule, and notification resources."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ocid1\\.(compartment|tenancy)\\.", var.compartment_ocid))
    error_message = "compartment_ocid must be an OCI compartment or tenancy OCID."
  }
}

variable "data_volume_ocid" {
  description = "Exact existing data Block Volume protected by this control root."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ocid1\\.volume\\.", var.data_volume_ocid))
    error_message = "data_volume_ocid must be an OCI Block Volume OCID."
  }
}

variable "name_prefix" {
  description = "Stable display-name prefix for the backup control-plane resources."
  type        = string
  default     = "easysubway-a1"
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]+(?:-[a-z0-9]+)*$", var.name_prefix))
    error_message = "name_prefix must be lowercase kebab-case."
  }
}

variable "data_volume_backup_slack_webhook_url" {
  description = "Owner Slack incoming-webhook endpoint for data volume backup failure notifications."
  type        = string
  nullable    = false
  sensitive   = true

  validation {
    condition     = can(regex("^https://hooks\\.slack\\.com/services/[^/?#\\s]+/[^/?#\\s]+/[^/?#\\s]+$", trimspace(var.data_volume_backup_slack_webhook_url)))
    error_message = "data_volume_backup_slack_webhook_url must be a canonical Slack incoming-webhook URL without query parameters."
  }
}

variable "enable_backup_failure_event_rule" {
  description = "Create the failure event rule only after the email subscription is ACTIVE."
  type        = bool
  default     = false
  nullable    = false
}
