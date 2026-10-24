# Chave por ambiente E por camada. Uma chave só por ambiente faria as duas
# camadas compartilharem state, e aí destruir a efêmera ameaçaria a
# persistente — exatamente o que a separação existe para impedir.
terraform {
  backend "s3" {
    key            = "dev/persistente.tfstate"
    region         = "us-east-1"
    dynamodb_table = "arremate-tflock"
    encrypt        = true
    # bucket vem do bootstrap, via -backend-config na hora do init
  }
}
