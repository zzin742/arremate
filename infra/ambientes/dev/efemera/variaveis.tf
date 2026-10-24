variable "regiao" {
  type    = string
  default = "us-east-1"
}

variable "prefixo" {
  type    = string
  default = "arremate"
}

variable "ambiente" {
  type    = string
  default = "dev"
}

variable "sessao_ativa" {
  type        = bool
  default     = true
  description = <<-TXT
    false zera as tarefas e desliga o Auto Scaling. É o primeiro passo do
    encerramento: com wait_for_steady_state, o apply bloqueia até as
    tarefas drenarem (doc 05, §6.4).
  TXT
}

variable "snapshot_sessao" {
  type        = string
  default     = ""
  description = "AAAAMMDD-HHMM do snapshot a restaurar na retomada. Vazio cria banco limpo."
}

variable "imagem_tag" {
  type        = string
  default     = "latest"
  description = "Tag da imagem no ECR; o CI usa o SHA do commit"
}

variable "bucket_state" {
  type        = string
  description = "Bucket criado pelo bootstrap; vem do -backend-config no init"
}
