terraform {
  backend "s3" {
    key            = "dev/efemera.tfstate"
    region         = "us-east-1"
    dynamodb_table = "arremate-tflock"
    encrypt        = true
  }
}
