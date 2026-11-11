//go:build !darwin

package platform

import (
	"fmt"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
)

func Run(info product.Info) error {
	return fmt.Errorf("%s GUI currently targets macOS arm64", info.Name)
}
