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

variable "snapshot_sessao" {
  type        = string
  default     = ""
  description = <<-TXT
    Identificador da sessão, no formato AAAAMMDD-HHMM. Vazio não cria
    snapshot. Preenchido, cria um com esse nome e espera ficar disponível
    antes de concluir o apply — é isso que autoriza o destroy da camada
    efêmera (doc 05, §6.4).
  TXT
}
